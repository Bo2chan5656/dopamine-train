import type { ArmCapture, Calibration } from '../../core/detect/calibration';
import { summarizeCapture } from '../../core/detect/calibration';
import { createRepDetector, DEFAULT_DETECTOR_CONFIG, type DetectorConfig } from '../../core/detect/rep-detector';
import {
  createSignalExtractor,
  probeFrame,
  type FrameProbe,
  type FrameSize,
  type SignalExtractor,
} from '../../core/detect/signal';
import { Emitter } from '../../core/emitter';
import type { ArmSide, Landmarks, Ms, SignalKind, SignalSample } from '../../core/types';
import type { RepSource, RepSourceEvents } from '../rep-source';
import { createCamera, type Camera, type FrameMeta } from './camera';
import { armLengthPx, getArmKeypoints } from './keypoints';
import { loadMoveNet, type MoveNetHandle, type MoveNetPose } from './movenet';

export interface PoseSourceConfig {
  readonly side: ArmSide;
  readonly calibration: Calibration;
  readonly detectorConfig: DetectorConfig;
}

// M5 のキャリブレーションウィザードが実測するまでの仮の値。M4 の目的は「信号の
// グラフがどれだけ滑らかか」を見ることであり、この仮の値のままで検証できる —
// レップ判定の正確さそのものは M5（実キャリブレーション後）で確認する。
const DEFAULT_CALIBRATION: Calibration = {
  signal: 'elbow-angle',
  side: 'right',
  view: 'side45',
  bottomRaw: 170,
  topRaw: 40,
  armLenPx: 200,
  createdAt: 0,
};

function defaultConfig(): PoseSourceConfig {
  return { side: 'right', calibration: DEFAULT_CALIBRATION, detectorConfig: DEFAULT_DETECTOR_CONFIG };
}

export interface PoseSource extends RepSource {
  /** キャリブレーション/腕/検出閾値を re-init なしで反映する（M5 のウィザードから呼ぶ）。 */
  reconfigure(patch: Partial<PoseSourceConfig>): void;
  /** dev panel 用。カメラ / 推論の稼働統計。 */
  cameraStats(): ReturnType<Camera['getStats']>;
  /** caps.preview:true の実体。ui/camera-preview.ts の attachVideo() に渡す。 */
  videoElement(): HTMLVideoElement;
  /** 直近フレームの生キーポイント（ui/camera-preview.ts の骨格オーバーレイ描画用）。 */
  lastKeypoints(): MoveNetPose['keypoints'] | null;
  /**
   * windowMs 間、**両腕**の生信号と体の向きを観測して代表値を返す
   * （calibration-wizard.ts 用）。観測中は detector に流さない
   * （キャリブレーション前の未確定な値でレップ判定を汚さないため）。
   *
   * ★ 両腕を測るのは、カメラを体の左右どちらの斜め45度に置いても使えるように
   * するため。どちらの腕を使うかは resolveCalibration() が測定値から決める。
   *
   * ★ signal を**引数で受け取る**。以前は内部の config.calibration.signal を
   * 使っていたが、キャリブレーション前のそれは仮の DEFAULT_CALIBRATION の値
   * （'elbow-angle'）でしかなく、ウィザードが検証に使う信号と食い違った。
   * 結果「記録は肘角度、判定は手首高さの規則」となり、正しい順で撮っても
   * 必ず inverted になるバグを踏んだ（実機で確認: 下端175.60 / 上端18.77 で
   * 手首高さの向き判定が偽になる）。「何の信号を測るか」を知っているのは
   * 呼び出し側なので、引数にして食い違いを構造的に不可能にする。
   */
  probe(windowMs: Ms, signal: SignalKind): Promise<ArmCapture>;
  /** 直近フレームの上腕長（ピクセル）。dev panel 等の即時表示用。 */
  currentArmLengthPx(): number | null;
  /**
   * 現在の映像サイズ。キーポイントが画面端/画面外に出ているかの判定に使う
   * （「腕を下ろしたら手首がフレームから切れている」を数字で示すため）。
   */
  frameSize(): FrameSize | null;
}

/**
 * camera + movenet + signal + detector の合成。M4 時点では DEFAULT_CALIBRATION
 * （仮の値）のまま動かすため、'rep' イベントは技術的には出るが、その正確さは
 * まだ検証しない。M4 の検証対象は 'progress'（信号の形）と 'tracking' のみ。
 */
export function createPoseSource(initial: Partial<PoseSourceConfig> = {}): PoseSource {
  const events = new Emitter<RepSourceEvents>();
  const camera = createCamera();
  let movenet: MoveNetHandle | null = null;
  let config: PoseSourceConfig = { ...defaultConfig(), ...initial };
  let extractor: SignalExtractor = createSignalExtractor(config.calibration.signal);
  let detector = createRepDetector(config.detectorConfig, config.calibration, config.side);
  let inferMsEma = 0;
  let lastKeypoints: MoveNetPose['keypoints'] | null = null;

  // probe() 実行中だけ使う一時状態。同時に1つの観測しか許可しない
  // （calibration-wizard.ts は1ステップずつ順番に呼ぶ前提）。
  let probingUntil: Ms | null = null;
  let probeBuffer: FrameProbe[] = [];
  /** 姿勢が取れなかったフレーム数。★代表値には入れず、ここで数えるだけ。 */
  let probeDropped = 0;
  let probeResolve: ((c: ArmCapture) => void) | null = null;
  /** probe() 実行中に測る信号。★呼び出し側が指定した値であり、config とは独立。 */
  let probeSignal: SignalKind = 'elbow-angle';
  // init() の時点でフレームポンプは開始する（sample() をキャリブレーション中に
  // 使うため）が、レップ判定は明示的に start() が呼ばれるまで無効にしておく —
  // 仮のキャリブレーションのままレップイベントが飛び続けるのを防ぐ。
  let detectorEnabled = false;

  function currentFrameSize(): FrameSize | null {
    const v = camera.video;
    return v.videoWidth > 0 && v.videoHeight > 0 ? { width: v.videoWidth, height: v.videoHeight } : null;
  }

  function finishProbe(): void {
    const result = summarizeCapture(probeBuffer, probeDropped);
    probingUntil = null;
    probeBuffer = [];
    probeDropped = 0;
    probeResolve?.(result);
    probeResolve = null;
  }

  function feedDetector(sample: SignalSample): void {
    if (!detectorEnabled) return;
    for (const o of detector.update(sample)) {
      if (o.type === 'rep') events.emit('rep', o.rep);
      else if (o.type === 'progress') events.emit('progress', { value: o.value, phase: o.phase, at: sample.at });
      else if (o.type === 'tracking') events.emit('tracking', o.state);
      // 'diagnostic' は 'diag'（fps/inferMs/dropped＝カメラ性能の話）とは別物なので、
      // 専用の 'diagnostic' イベントで流す。★ここで捨ててはいけない — 捨てると
      // 「カールしてるのにレップが増えない、理由が分からない」が起きる。
      else events.emit('diagnostic', { hint: o.hint, observedMax: o.observedMax, observedMin: o.observedMin });
    }
  }

  async function handleFrame(video: HTMLVideoElement, meta: FrameMeta): Promise<void> {
    if (!movenet) return;
    const t0 = performance.now();
    const pose = await movenet.estimate(video, meta.mediaTimeMs);
    const inferMs = performance.now() - t0;
    inferMsEma = inferMsEma === 0 ? inferMs : inferMsEma * 0.8 + inferMs * 0.2;
    lastKeypoints = pose?.keypoints ?? null; // camera-preview の骨格オーバーレイ用

    const lm: Landmarks | null = pose ? { at: meta.captureAtMs, kp: pose.keypoints } : null;

    if (probingUntil !== null) {
      // ★キャリブレーション記録中。姿勢が取れたフレームだけを代表値の計算に入れる。
      // 以前は下の「score:0 のダミーサンプル」がそのまま記録バッファに入っており、
      // 1秒の記録中に1フレームでも姿勢を落とすと minScore が 0 になって
      // low_confidence 確定で失敗する、という実質的なバグになっていた。
      // 姿勢が取れなかったフレームは欠測であって観測値ではない。
      if (lm) probeBuffer.push(probeFrame(lm, probeSignal, currentFrameSize()));
      else probeDropped += 1;
      if (meta.captureAtMs >= probingUntil) finishProbe();
      // 観測中は detector に流さない（未確定のキャリブレーションでレップ判定を汚さない）
      emitDiag();
      return;
    }

    // pose が取れない/必要なキーポイントが欠ける場合は score=0 のダミーサンプルとして
    // detector に渡す。「一定時間見失った」の判定(lost)は detector 側に一元化する
    // （ここで独自に lost を判定すると detector のステートマシンと二重管理になる）。
    const sample = lm ? extractor.extract(lm, config.side) : null;
    feedDetector(sample ?? { at: meta.captureAtMs, raw: 0, score: 0 });
    emitDiag();
  }

  function emitDiag(): void {
    const stats = camera.getStats();
    events.emit('diag', {
      fps: stats.fps,
      inferMs: Math.round(inferMsEma),
      dropped: stats.dropInFlight + stats.dropPacing,
      source: stats.source,
      joints: activeJointScores(),
    });
  }

  /** 判定に使っている側の腕の関節別 score。dev panel のライブ表示用。 */
  function activeJointScores(): { shoulder: number; elbow: number; wrist: number } | null {
    if (!lastKeypoints) return null;
    const side = config.side === 'both' ? 'left' : config.side;
    const probe = probeFrame({ at: 0, kp: lastKeypoints }, config.calibration.signal, currentFrameSize());
    return side === 'left' ? probe.left.scores : probe.right.scores;
  }

  return {
    kind: 'webcam-movenet',
    caps: { calibration: true, progress: true, preview: true },
    events,

    async init(): Promise<void> {
      movenet = await loadMoveNet();
      await camera.start(); // カメラ許可・映像取得
      camera.setFrameHandler(handleFrame); // フレームポンプ開始（sample() をキャリブレーション中に使うため）
    },
    start(): void {
      detectorEnabled = true;
      // stop() 後の再開はここで非同期に再取得する。RepSource.start() は同期シグネチャ
      // なので fire-and-forget にならざるを得ない — 失敗は 'tracking':no-sensor で通知する。
      // camera.start() は「既に stream があれば何もしない」冪等設計なので、init()
      // 直後の最初の呼び出しでは即座に handler 設定へ進む。
      camera
        .start()
        .then(() => camera.setFrameHandler(handleFrame))
        .catch((err: unknown) => {
          console.error('[pose-source] camera start failed', err);
          events.emit('tracking', { kind: 'no-sensor', reason: String(err) });
        });
    },
    stop(): void {
      detectorEnabled = false;
      camera.stop(); // トラック破棄。カメラ LED が消える（熱対策）。
    },
    async dispose(): Promise<void> {
      camera.stop();
      movenet?.dispose();
      movenet = null;
    },

    reconfigure(patch: Partial<PoseSourceConfig>): void {
      config = { ...config, ...patch };
      if (patch.calibration) extractor = createSignalExtractor(config.calibration.signal);
      if (patch.calibration || patch.detectorConfig || patch.side) {
        detector = createRepDetector(config.detectorConfig, config.calibration, config.side);
      }
    },
    cameraStats(): ReturnType<Camera['getStats']> {
      return camera.getStats();
    },
    videoElement(): HTMLVideoElement {
      return camera.video;
    },
    lastKeypoints(): MoveNetPose['keypoints'] | null {
      return lastKeypoints;
    },

    probe(windowMs: Ms, signal: SignalKind): Promise<ArmCapture> {
      // 前回の観測が何らかの理由で終わっていなければ、そこまでの分で即座に片付ける
      // （calibration-wizard.ts は直列にしか呼ばないはずだが、多重起動の防御）。
      if (probeResolve) finishProbe();
      return new Promise<ArmCapture>((resolve) => {
        probeResolve = resolve;
        probeSignal = signal;
        probeBuffer = [];
        probeDropped = 0;
        probingUntil = performance.now() + windowMs;
      });
    },
    frameSize(): FrameSize | null {
      return currentFrameSize();
    },
    currentArmLengthPx(): number | null {
      if (!lastKeypoints) return null;
      const side = config.side === 'both' ? 'left' : config.side;
      const arm = getArmKeypoints(lastKeypoints, side);
      return arm ? armLengthPx(arm.shoulder, arm.elbow) : null;
    },
  };
}
