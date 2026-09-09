export interface FrameMeta {
  /** フレームの capture 時刻。metadata.captureTime があればそれを、無ければ rVFC の now。 */
  readonly captureAtMs: number;
  readonly mediaTimeMs: number;
  readonly presentedFrames: number;
}

export type FrameHandler = (video: HTMLVideoElement, meta: FrameMeta) => Promise<void>;

export interface CameraStats {
  /** 直近1秒間に実際に処理し終えたフレーム数。 */
  readonly fps: number;
  readonly dropInFlight: number;
  readonly dropPacing: number;
  /**
   * カメラが**実際に採用した**設定（要求値ではない）。
   * ★ 計画で「実際に何が採用されたか必ず確認する」としていたのに実装が漏れていた。
   * これが見えないと「fps が低いのは暗所でカメラが露光を伸ばしているのか、
   * こちら側のペーシングの問題なのか」が切り分けられない。
   */
  readonly source: { readonly width: number; readonly height: number; readonly fps: number } | null;
}

/**
 * ★ 解像度を 640x360 から上げた。
 *
 * 以前は「MoveNet の入力は 192x192 なので 640x360 で十分すぎる」という理屈だったが、
 * これは間違い。MoveNet は**人物の周りを切り出して 192x192 にリサイズする**ので、
 * 元映像の解像度が高いほど切り出した領域に入る実ピクセル数が増える。1.5〜2m 離れて
 * 人物がフレームの一部しか占めない状況では、640x360 だと切り出し後の実解像度が
 * 足りず、手首のような末端の関節から信頼度が落ちる。
 * 推論負荷はほぼ変わらない（モデル入力は 192x192 のまま。増えるのはカメラの
 * デコードとクロップのコストだけ）。
 */
const DEFAULT_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 24, max: 24 },
  facingMode: 'user',
};

export interface Camera {
  readonly video: HTMLVideoElement;
  /** getUserMedia → 黒画ガード → rVFC ポンプ開始。冪等（既に開始済みなら何もしない）。 */
  start(constraints?: MediaTrackConstraints): Promise<void>;
  /** track.stop()。カメラ LED が消える。再開には start() をもう一度呼ぶ（300〜800ms かかる）。 */
  stop(): void;
  setFrameHandler(handler: FrameHandler | null): void;
  setTargetFps(fps: number): void;
  getStats(): CameraStats;
}

/**
 * getUserMedia + requestVideoFrameCallback による推論フレームポンプ。
 *
 * 規則: ①キューに積まない（latest-wins。in-flight 中は古いフレームを捨てる）
 * ②requestAnimationFrame でペーシングしない（rVFC が正解。captureTime が取れる）
 * ③in-flight ガードなしで handler を呼ばない（ここを間違えると数分後に遅延が伸びる）。
 */
export function createCamera(): Camera {
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  let stream: MediaStream | null = null;
  let handler: FrameHandler | null = null;
  let targetFps = 24;
  let running = false;
  let inFlight = false;
  let lastRunMs = 0;
  let lastPresentedFrames = -1;

  let dropInFlight = 0;
  let dropPacing = 0;
  let sourceSettings: CameraStats['source'] = null;
  let processedAt: number[] = [];

  function onFrame(now: number, metadata: VideoFrameCallbackMetadata): void {
    if (!running) return;
    video.requestVideoFrameCallback(onFrame); // ★常に最初に次を予約する

    if (!handler) return;
    if (metadata.presentedFrames === lastPresentedFrames) return; // 同一フレームの重複発火
    if (inFlight) {
      dropInFlight++;
      return;
    }
    // ★許容を「半周期」にしている。以前は period - 2（固定2ms）だったが、これだと
    // カメラの実フレームレートが目標を少し上回るだけで**実効レートが半分に落ちる**。
    // 例: カメラ30fps(33.3ms間隔) / 目標24fps(period=41.7ms, 閾値39.7ms) のとき、
    // 33.3 < 39.7 なので1枚おきに捨てられ、24fps を狙って 15fps しか出ない
    // （実機で fps=12, dropped=5356 として観測された）。
    // 半周期(20.8ms)なら 33.3ms 間隔の入力はすべて通る。上振れは in-flight ガードと
    // 推論時間(約20ms)が吸収する。
    const period = 1000 / targetFps;
    if (now - lastRunMs < period * 0.5) {
      dropPacing++;
      return;
    }

    lastRunMs = now;
    lastPresentedFrames = metadata.presentedFrames;
    inFlight = true;

    const meta: FrameMeta = {
      captureAtMs: metadata.captureTime ?? now, // フォールバック必須（getUserMedia起点では入らないブラウザがある）
      mediaTimeMs: metadata.mediaTime * 1000,
      presentedFrames: metadata.presentedFrames,
    };

    handler(video, meta)
      .catch((err: unknown) => console.error('[camera] frame handler failed', err))
      .finally(() => {
        inFlight = false;
        processedAt.push(now);
        const cutoff = now - 1000;
        processedAt = processedAt.filter((t) => t >= cutoff);
      });
  }

  async function waitForReadyFrame(): Promise<void> {
    // macOS Chrome はカメラ初期化直後に数フレーム黒画を返すことがある。
    if (video.readyState >= 2 && video.videoWidth > 0) return;
    await new Promise<void>((resolve) => {
      function check(): void {
        if (video.readyState >= 2 && video.videoWidth > 0) resolve();
        else requestAnimationFrame(check);
      }
      check();
    });
  }

  return {
    video,

    async start(constraints = DEFAULT_CONSTRAINTS): Promise<void> {
      if (stream) return; // 既に開始済み
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
      video.srcObject = stream;
      await video.play();
      await waitForReadyFrame();

      const track = stream.getVideoTracks()[0];
      if (track) {
        const st = track.getSettings();
        sourceSettings = {
          width: st.width ?? 0,
          height: st.height ?? 0,
          fps: st.frameRate ?? 0,
        };
        console.log('[camera] 採用された設定', sourceSettings);
      }

      running = true;
      lastPresentedFrames = -1;
      video.requestVideoFrameCallback(onFrame);
    },

    stop(): void {
      running = false;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
      video.srcObject = null;
    },

    setFrameHandler(h: FrameHandler | null): void {
      handler = h;
    },
    setTargetFps(fps: number): void {
      targetFps = fps;
    },
    getStats(): CameraStats {
      return { fps: processedAt.length, dropInFlight, dropPacing, source: sourceSettings };
    },
  };
}
