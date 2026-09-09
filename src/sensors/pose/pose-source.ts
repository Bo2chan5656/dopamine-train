import type { Calibration, CalibrationSample } from '../../core/detect/calibration';
import { summarize } from '../../core/detect/calibration';
import { createRepDetector, DEFAULT_DETECTOR_CONFIG, type DetectorConfig } from '../../core/detect/rep-detector';
import { createSignalExtractor, type SignalExtractor } from '../../core/detect/signal';
import { Emitter } from '../../core/emitter';
import type { ArmSide, Landmarks, Ms, SignalSample } from '../../core/types';
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
   * windowMs 間、現在の signal/side 設定のまま生の信号をサンプリングして代表値を
   * 返す（calibration-wizard.ts 用）。サンプリング中は detector に流さない
   * （キャリブレーション前の未確定な値でレップ判定を汚さないため）。
   */
  sample(windowMs: Ms): Promise<CalibrationSample>;
  /** 直近フレームの上腕長（ピクセル）。キャリブレーション記録時の診断値に使う。 */
  currentArmLengthPx(): number | null;
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

  // sample() 実行中だけ使う一時状態。同時に1つのサンプリングしか許可しない
  // （calibration-wizard.ts は1ステップずつ順番に呼ぶ前提）。
  let samplingUntil: Ms | null = null;
  let samplingBuffer: SignalSample[] = [];
  let samplingResolve: ((s: CalibrationSample) => void) | null = null;
  // init() の時点でフレームポンプは開始する（sample() をキャリブレーション中に
  // 使うため）が、レップ判定は明示的に start() が呼ばれるまで無効にしておく —
  // 仮のキャリブレーションのままレップイベントが飛び続けるのを防ぐ。
  let detectorEnabled = false;

  function feedDetector(sample: SignalSample): void {
    if (samplingUntil !== null) {
      samplingBuffer.push(sample);
      if (sample.at >= samplingUntil) {
        const result = summarize(samplingBuffer);
        samplingUntil = null;
        samplingBuffer = [];
        samplingResolve?.(result);
        samplingResolve = null;
      }
      return; // サンプリング中は detector に渡さない
    }
    if (!detectorEnabled) return;
    for (const o of detector.update(sample)) {
      if (o.type === 'rep') events.emit('rep', o.rep);
      else if (o.type === 'progress') events.emit('progress', { value: o.value, phase: o.phase, at: sample.at });
      else if (o.type === 'tracking') events.emit('tracking', o.state);
      // 'diagnostic'（threshold_unreachable）は RepSourceEvents.diag（fps/inferMs/dropped、
      // カメラ性能の話）とは別物なので、そちらには流さない。dev-panel は detector の
      // 'progress' 系列を直接見て閾値到達の可否を判断する。
    }
  }

  async function handleFrame(video: HTMLVideoElement, meta: FrameMeta): Promise<void> {
    if (!movenet) return;
    const t0 = performance.now();
    const pose = await movenet.estimate(video, meta.mediaTimeMs);
    const inferMs = performance.now() - t0;
    inferMsEma = inferMsEma === 0 ? inferMs : inferMsEma * 0.8 + inferMs * 0.2;
    lastKeypoints = pose?.keypoints ?? null; // camera-preview の骨格オーバーレイ用

    // pose が取れない/必要なキーポイントが欠ける場合も score=0 のダミーサンプルとして
    // detector に渡す。「一定時間見失った」の判定(lost)は detector 側に一元化する
    // （ここで独自に lost を判定すると detector のステートマシンと二重管理になる）。
    const lm: Landmarks | null = pose ? { at: meta.captureAtMs, kp: pose.keypoints } : null;
    const sample = lm ? extractor.extract(lm, config.side) : null;
    feedDetector(sample ?? { at: meta.captureAtMs, raw: 0, score: 0 });

    const stats = camera.getStats();
    events.emit('diag', { fps: stats.fps, inferMs: Math.round(inferMsEma), dropped: stats.dropInFlight + stats.dropPacing });
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

    sample(windowMs: Ms): Promise<CalibrationSample> {
      // 前回のサンプリングが何らかの理由で終わっていなければ、空扱いで即座に片付ける
      // （calibration-wizard.ts は直列にしか呼ばないはずだが、多重起動の防御）。
      samplingResolve?.(summarize(samplingBuffer));
      samplingBuffer = [];
      return new Promise<CalibrationSample>((resolve) => {
        samplingResolve = resolve;
        samplingUntil = performance.now() + windowMs;
      });
    },
    currentArmLengthPx(): number | null {
      if (!lastKeypoints) return null;
      const side = config.side === 'both' ? 'left' : config.side;
      const arm = getArmKeypoints(lastKeypoints, side);
      return arm ? armLengthPx(arm.shoulder, arm.elbow) : null;
    },
  };
}
