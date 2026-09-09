import type { TrackingState } from '../core/types';
import './styles/dev-panel.css';

const HISTORY_MS = 5000;
const GRAPH_WIDTH = 480;
const GRAPH_HEIGHT = 160;

export interface DevPanelDiag {
  readonly fps: number;
  readonly inferMs: number;
  readonly dropped: number;
  /** カメラが実際に採用した設定。要求値と一致しないことがある。 */
  readonly source: { readonly width: number; readonly height: number; readonly fps: number } | null;
  /** 判定に使っている腕の関節別 score。 */
  readonly joints: { readonly shoulder: number; readonly elbow: number; readonly wrist: number } | null;
}

export interface DevPanel {
  updateDiag(diag: DevPanelDiag): void;
  updateTracking(state: TrackingState): void;
  /** 直近5秒の折れ line グラフ用データポイントを追加する。value は 0..1 目安（範囲外も描画は可）。 */
  pushSignal(value: number, atMs: number): void;
  setThresholds(bottomThreshold: number, topThreshold: number): void;
  /** 関節別 score の合否ライン（検出器の warnScore）を表示に反映する。 */
  setWarnScore(warnScore: number): void;
}

/**
 * fps/推論ms/score/drop/信号グラフ。閾値チューニングの主要な道具 —
 * 「カールしてるのに数が増えない」の原因を沈黙させないための必須ツール（飾りではない）。
 */
export function createDevPanel(root: HTMLElement): DevPanel {
  const container = document.createElement('div');
  container.className = 'dt-dev-panel';
  container.innerHTML = `
    <div class="dt-dev-panel__stats" data-el="stats"></div>
    <canvas class="dt-dev-panel__graph" data-el="graph" width="${GRAPH_WIDTH}" height="${GRAPH_HEIGHT}"></canvas>
  `;
  root.appendChild(container);

  const statsEl = container.querySelector<HTMLDivElement>('[data-el="stats"]');
  const canvas = container.querySelector<HTMLCanvasElement>('[data-el="graph"]');
  const ctx = canvas?.getContext('2d') ?? null;

  let history: Array<{ readonly value: number; readonly at: number }> = [];
  let bottomThreshold = 0.2;
  let topThreshold = 0.8;
  /** 関節別 score の合否ラインの表示用。setThresholds と同様に外から設定する。 */
  let warnScore = 0.35;
  let lastDiag: DevPanelDiag = { fps: 0, inferMs: 0, dropped: 0, source: null, joints: null };
  let lastTracking: TrackingState = { kind: 'no-sensor', reason: 'not started' };

  function renderStats(): void {
    if (!statsEl) return;
    // ★ camera 行が肝。処理 fps が低いとき「暗所でカメラ自身が露光を伸ばして
    // フレームレートを落としている」のか「こちら側のペーシングで捨てている」のかを
    // 切り分けるには、カメラが実際に採用した設定を見るしかない。
    const src = lastDiag.source;
    const j = lastDiag.joints;
    // ★ joints 行が運動中のデバッグの本体。無効理由 'low_confidence' は
    // min(肩,肘,手首) で決まるので、どれが落ちているかはここでしか分からない。
    // 閾値(warnScore=0.35)を下回っている関節に ← を付ける。
    const mark = (v: number): string => (v < warnScore ? ' ←' : '');
    statsEl.textContent =
      `fps=${lastDiag.fps} inferMs=${lastDiag.inferMs} dropped=${lastDiag.dropped}\n` +
      `camera=${src ? `${src.width}x${src.height}@${src.fps.toFixed(0)}fps` : '?'}\n` +
      `tracking=${lastTracking.kind}${'minScore' in lastTracking ? ` score=${lastTracking.minScore.toFixed(2)}` : ''}\n` +
      (j
        ? `肩=${j.shoulder.toFixed(2)}${mark(j.shoulder)} 肘=${j.elbow.toFixed(2)}${mark(j.elbow)} 手首=${j.wrist.toFixed(2)}${mark(j.wrist)}  (必要 ${warnScore.toFixed(2)})`
        : '肩/肘/手首 = 未検出');
  }

  function renderGraph(): void {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const toY = (v: number): number => h - Math.max(0, Math.min(1, v)) * h;

    // 閾値ライン（点線）
    ctx.strokeStyle = '#fbbf24';
    ctx.setLineDash([4, 4]);
    for (const th of [bottomThreshold, topThreshold]) {
      ctx.beginPath();
      ctx.moveTo(0, toY(th));
      ctx.lineTo(w, toY(th));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (history.length < 2) return;
    const now = history[history.length - 1]!.at;
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 2;
    ctx.beginPath();
    history.forEach((p, i) => {
      const x = w - ((now - p.at) / HISTORY_MS) * w;
      const y = toY(p.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  return {
    updateDiag(diag: DevPanelDiag): void {
      lastDiag = diag;
      renderStats();
    },
    updateTracking(state: TrackingState): void {
      lastTracking = state;
      renderStats();
    },
    pushSignal(value: number, atMs: number): void {
      history.push({ value, at: atMs });
      const cutoff = atMs - HISTORY_MS;
      history = history.filter((p) => p.at >= cutoff);
      renderGraph();
    },
    setThresholds(bottom: number, top: number): void {
      bottomThreshold = bottom;
      topThreshold = top;
      renderGraph();
    },
    setWarnScore(v: number): void {
      warnScore = v;
      renderStats();
    },
  };
}
