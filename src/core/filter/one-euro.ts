export interface OneEuroConfig {
  readonly minCutoff: number; // Hz
  readonly beta: number;
  readonly dCutoff: number; // Hz
}

/** カール1回が0.5〜1Hz程度である前提のスターティングポイント。M6 のリプレイでチューニングする。 */
export const DEFAULT_ONE_EURO_CONFIG: OneEuroConfig = {
  minCutoff: 1.0,
  beta: 1.0,
  dCutoff: 1.0,
};

/**
 * One-Euro Filter。0..1 に正規化したスカラ信号1本に適用する前提（ランドマークにも
 * 角度にも直接は適用しない — MoveNet 側の enableSmoothing は無効化し、ここで一本化する）。
 * 速い動きでは実効カットオフが上がり追従が速くなる（＝閾値近傍での遅れが減る）。
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(private readonly cfg: OneEuroConfig) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  /** x: 生値, tSec: 秒単位の単調時刻。 */
  filter(x: number, tSec: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = tSec;
      this.dxPrev = 0;
      return x;
    }

    // dt=0（同一タイムスタンプ2連続）と巨大 dt（長時間の欠測明け）を両方防ぐ。
    const dt = clamp(tSec - this.tPrev, 1e-3, 0.5);
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.cfg.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.cfg.minCutoff + this.cfg.beta * Math.abs(dxHat);
    const a = alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tSec;
    return xHat;
  }
}

function alpha(cutoffHz: number, dtSec: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
