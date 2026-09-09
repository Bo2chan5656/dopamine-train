import type { TrackingState } from '../core/types';
import './styles/dev-panel.css';

const HISTORY_MS = 5000;
const GRAPH_WIDTH = 480;
const GRAPH_HEIGHT = 160;

export interface DevPanelDiag {
  readonly fps: number;
  readonly inferMs: number;
  readonly dropped: number;
}

export interface DevPanel {
  updateDiag(diag: DevPanelDiag): void;
  updateTracking(state: TrackingState): void;
  /** 直近5秒の折れ line グラフ用データポイントを追加する。value は 0..1 目安（範囲外も描画は可）。 */
  pushSignal(value: number, atMs: number): void;
  setThresholds(bottomThreshold: number, topThreshold: number): void;
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
  let lastDiag: DevPanelDiag = { fps: 0, inferMs: 0, dropped: 0 };
  let lastTracking: TrackingState = { kind: 'no-sensor', reason: 'not started' };

  function renderStats(): void {
    if (!statsEl) return;
    statsEl.textContent =
      `fps=${lastDiag.fps} inferMs=${lastDiag.inferMs} dropped=${lastDiag.dropped}\n` +
      `tracking=${lastTracking.kind}${'minScore' in lastTracking ? ` score=${lastTracking.minScore.toFixed(2)}` : ''}`;
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
  };
}
