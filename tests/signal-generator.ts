import type { Calibration } from '../src/core/detect/calibration';
import { denormalize } from '../src/core/detect/calibration';
import type { Ms, SignalSample } from '../src/core/types';

/** 決定論的な疑似乱数（mulberry32）。テストの再現性のためシード固定で使う。 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller。平均0・分散1の正規分布乱数。 */
function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export interface SineWaveOptions {
  readonly fps: number;
  readonly cycles: number;
  readonly cycleMs: Ms;
  readonly noiseSigma?: number;
  readonly startAt?: Ms;
  readonly score?: number;
  readonly seed?: number;
  /** 正弦の振幅の中心・半幅。既定は 0..1 をフルに使う（下端0・上端1）。 */
  readonly ampCenter?: number;
  readonly ampRadius?: number;
}

/**
 * 正規化空間(0..1)でのなめらかな正弦往復を、Calibration の raw 単位に変換して生成する。
 * cos ベースなので各サイクルの前半が上昇(concentric)・後半が下降(eccentric)になる。
 */
export function sineWave(cal: Calibration, opts: SineWaveOptions): SignalSample[] {
  const {
    fps,
    cycles,
    cycleMs,
    noiseSigma = 0,
    startAt = 0,
    score = 1,
    seed = 1,
    ampCenter = 0.5,
    ampRadius = 0.5,
  } = opts;
  const frameMs = 1000 / fps;
  const totalMs = cycles * cycleMs;
  const rng = mulberry32(seed);
  const samples: SignalSample[] = [];
  for (let t = 0; t <= totalMs + 1e-6; t += frameMs) {
    const localPhase = (t % cycleMs) / cycleMs; // 0..1
    const norm01 = ampCenter - ampRadius * Math.cos(2 * Math.PI * localPhase);
    const noise = noiseSigma > 0 ? gaussian(rng) * noiseSigma : 0;
    const raw = denormalize(clamp01(norm01 + noise), cal);
    samples.push({ at: startAt + t, raw, score });
  }
  return samples;
}

/** 閾値付近など、ある正規化値の周りを高周波でわずかに振動させる（フルレップにはならない）。 */
export function jitterNear(
  cal: Calibration,
  opts: { readonly center: number; readonly amplitude: number; readonly hz: number; readonly durationMs: Ms; readonly fps: number; readonly startAt?: Ms; readonly score?: number },
): SignalSample[] {
  const { center, amplitude, hz, durationMs, fps, startAt = 0, score = 1 } = opts;
  const frameMs = 1000 / fps;
  const samples: SignalSample[] = [];
  for (let t = 0; t <= durationMs; t += frameMs) {
    const norm01 = center + amplitude * Math.sin(2 * Math.PI * hz * (t / 1000));
    samples.push({ at: startAt + t, raw: denormalize(clamp01(norm01), cal), score });
  }
  return samples;
}

/** 下端→中間値→下端 を繰り返す「ハーフレップ」（topThreshold に届かない）。 */
export function halfReps(
  cal: Calibration,
  opts: { readonly count: number; readonly peakNorm: number; readonly halfCycleMs: Ms; readonly fps: number; readonly startAt?: Ms; readonly score?: number },
): SignalSample[] {
  const { count, peakNorm, halfCycleMs, fps, startAt = 0, score = 1 } = opts;
  return sineWave(cal, {
    fps,
    cycles: count,
    cycleMs: halfCycleMs * 2,
    startAt,
    score,
    ampCenter: peakNorm / 2,
    ampRadius: peakNorm / 2,
  });
}

/** 上昇(concentric)と下降(eccentric)で所要時間が異なる非対称な往復。 */
export function asymmetricReps(
  cal: Calibration,
  opts: {
    readonly count: number;
    readonly concentricMs: Ms;
    readonly eccentricMs: Ms;
    readonly fps: number;
    readonly startAt?: Ms;
    readonly score?: number;
  },
): SignalSample[] {
  const { count, concentricMs, eccentricMs, fps, startAt = 0, score = 1 } = opts;
  const frameMs = 1000 / fps;
  const samples: SignalSample[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    // 上昇: 0 -> 1（濃度勾配を smoothstep で。線形でも良いが端で速度0にした方が閾値付近が安定する）
    for (let u = 0; u <= concentricMs; u += frameMs) {
      const p = u / concentricMs;
      const norm01 = smoothstep(p);
      samples.push({ at: startAt + t + u, raw: denormalize(clamp01(norm01), cal), score });
    }
    t += Math.ceil(concentricMs / frameMs) * frameMs;
    // 下降: 1 -> 0
    for (let u = 0; u <= eccentricMs; u += frameMs) {
      const p = u / eccentricMs;
      const norm01 = 1 - smoothstep(p);
      samples.push({ at: startAt + t + u, raw: denormalize(clamp01(norm01), cal), score });
    }
    t += Math.ceil(eccentricMs / frameMs) * frameMs;
  }
  return samples;
}

function smoothstep(p: number): number {
  const c = clamp01(p);
  return c * c * (3 - 2 * c);
}

/**
 * 上昇の途中で完全に静止する区間を挟む（「上昇中に静止」シナリオ用）。
 * rise1: 0 -> midNorm, hold: midNorm を holdMs 維持, rise2: midNorm -> 1。
 */
export function stallDuringRise(
  cal: Calibration,
  opts: {
    readonly midNorm: number;
    readonly riseMs: Ms;
    readonly holdMs: Ms;
    readonly fps: number;
    readonly startAt?: Ms;
    readonly score?: number;
  },
): SignalSample[] {
  const { midNorm, riseMs, holdMs, fps, startAt = 0, score = 1 } = opts;
  const frameMs = 1000 / fps;
  const samples: SignalSample[] = [];
  let t = 0;
  for (let u = 0; u <= riseMs; u += frameMs) {
    const norm01 = smoothstep(u / riseMs) * midNorm;
    samples.push({ at: startAt + t + u, raw: denormalize(clamp01(norm01), cal), score });
  }
  t += Math.ceil(riseMs / frameMs) * frameMs;
  for (let u = 0; u <= holdMs; u += frameMs) {
    samples.push({ at: startAt + t + u, raw: denormalize(midNorm, cal), score });
  }
  t += Math.ceil(holdMs / frameMs) * frameMs;
  for (let u = 0; u <= riseMs; u += frameMs) {
    const norm01 = midNorm + smoothstep(u / riseMs) * (1 - midNorm);
    samples.push({ at: startAt + t + u, raw: denormalize(clamp01(norm01), cal), score });
  }
  return samples;
}

/** 指定区間の score を強制的に下げる（トラッキングロストの注入）。破壊的変更はしない。 */
export function withLowScoreWindow(
  samples: readonly SignalSample[],
  opts: { readonly fromMs: Ms; readonly toMs: Ms; readonly score: number },
): SignalSample[] {
  return samples.map((s) =>
    s.at >= opts.fromMs && s.at <= opts.toMs ? { ...s, score: opts.score } : s,
  );
}

/** 複数の SignalSample[] を時系列順に結合する（at の連続性はそのまま各区間の生成時刻に従う）。 */
export function concatSamples(...groups: readonly (readonly SignalSample[])[]): SignalSample[] {
  return groups.flat();
}
