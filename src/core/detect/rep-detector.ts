import { OneEuroFilter, type OneEuroConfig } from '../filter/one-euro';
import type { ArmSide, Ms, RepEvent, RepPhase, SignalSample, TrackingState } from '../types';
import { normalize, type Calibration } from './calibration';
import { evaluateRejects } from './validity';

export interface DetectorConfig {
  readonly topThreshold: number; // 既定 0.80  ★invariant: bottomThreshold + 0.3 <= topThreshold
  readonly bottomThreshold: number; // 既定 0.20
  readonly minConcentricMs: Ms; // 既定 400
  readonly maxConcentricMs: Ms; // 既定 4000
  readonly minEccentricMs: Ms; // 既定 500  ← テンポゲート＝速度上限の実体
  readonly minInterRepMs: Ms; // 既定 500
  readonly minRomRatio: number; // 既定 0.70
  readonly minScore: number; // 既定 0.30  フレーム破棄の閾値
  readonly warnScore: number; // 既定 0.50
  readonly lostAfterMs: Ms; // 既定 700
  readonly filterResetGapMs: Ms; // 既定 300
  readonly filter: OneEuroConfig;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  topThreshold: 0.8,
  bottomThreshold: 0.2,
  minConcentricMs: 400,
  maxConcentricMs: 4000,
  minEccentricMs: 500,
  minInterRepMs: 500,
  minRomRatio: 0.7,
  minScore: 0.3,
  warnScore: 0.5,
  lostAfterMs: 700,
  filterResetGapMs: 300,
  filter: { minCutoff: 1.0, beta: 1.0, dCutoff: 1.0 },
};

export type DetectorOutput =
  | { readonly type: 'progress'; readonly value: number; readonly phase: RepPhase }
  | { readonly type: 'rep'; readonly rep: RepEvent }
  | { readonly type: 'tracking'; readonly state: TrackingState }
  | { readonly type: 'diagnostic'; readonly hint: 'threshold_unreachable'; readonly observedMax: number };

export interface DetectorState {
  readonly phase: RepPhase;
  readonly lost: boolean;
  readonly sessionMax: number;
}

export interface RepDetector {
  /** ★副作用なし・時刻はサンプルから注入・I/Oなし。Date.now()/performance.now() を中で呼ばない。 */
  update(sample: SignalSample): DetectorOutput[];
  reset(): void;
  snapshot(): DetectorState;
}

const DIAG_SILENCE_MS = 15_000;
const DIAG_MIN_OBSERVED_MAX = 0.35;

/**
 * レップ検出のステートマシン本体。肘角度/手首高さいずれの信号でも、既に
 * normalize() 済みの 0..1 スカラを受け取る前提（信号非依存）。
 *
 * シュミットトリガ（2閾値ヒステリシス）+ One-Euro Filter + 信頼度ゲート + 沈黙診断。
 * レップは「上端到達の瞬間」に計上する（1周期の完了を待たない＝レイテンシが半分になる）。
 */
export function createRepDetector(cfg: DetectorConfig, cal: Calibration, side: ArmSide): RepDetector {
  const filter = new OneEuroFilter(cfg.filter);

  let phase: RepPhase = 'unknown';
  let lastT: Ms | null = null;
  let lowScoreSince: Ms | null = null;
  let lost = false;

  let bottomAt: Ms | null = null;
  let topAt: Ms | null = null;
  let trough = NaN;
  let peak = NaN;
  let repMinScore = 1;
  let pendingEccentricMs: Ms | null = null;

  let lastRepAt: Ms = -Infinity;
  let repId = 0;
  let sessionMax = 0;
  let lastRepOrDiagAt: Ms = -Infinity;

  function abortRep(): void {
    trough = NaN;
    peak = NaN;
    repMinScore = 1;
    bottomAt = null;
    topAt = null;
    pendingEccentricMs = null;
  }

  function enterBottom(t: Ms, xf: number): void {
    pendingEccentricMs = topAt !== null ? t - topAt : null;
    phase = 'at-bottom';
    bottomAt = t;
    trough = xf;
    peak = xf;
    repMinScore = 1;
  }

  function buildRep(t: Ms, xf: number): RepEvent {
    const concentricMs = bottomAt !== null ? t - bottomAt : 0;
    const romRatio = xf - trough;
    const rejects = evaluateRejects(
      {
        concentricMs,
        eccentricMs: pendingEccentricMs,
        romRatio,
        repMinScore,
        msSinceLastRep: t - lastRepAt,
      },
      cfg,
    );
    return {
      id: ++repId,
      at: t,
      concentricMs,
      eccentricMs: pendingEccentricMs,
      romRatio,
      peak: xf,
      minScore: repMinScore,
      side,
      valid: rejects.length === 0,
      rejects,
    };
  }

  function update(sample: SignalSample): DetectorOutput[] {
    const out: DetectorOutput[] = [];
    const t = sample.at;

    // (1) 信頼度ゲート — 低 score フレームは破棄する。フィルタに入れない、外挿も補間もしない。
    if (sample.score < cfg.minScore) {
      lowScoreSince ??= t;
      if (!lost && t - lowScoreSince >= cfg.lostAfterMs) {
        lost = true;
        abortRep(); // 進行中レップを破棄する
        out.push({ type: 'tracking', state: { kind: 'lost', sinceMs: lowScoreSince } });
      }
      return out;
    }
    if (lowScoreSince !== null && !lost) {
      // lostAfterMs に達する前に score が回復した（一瞬のブレ）。
      out.push({ type: 'tracking', state: { kind: 'ok', minScore: sample.score } });
    }
    lowScoreSince = null;

    if (lost) {
      // lostAfterMs を超えてから今回初めて回復した。★復帰直後は端に到達するまで数え始めない。
      lost = false;
      phase = 'unknown';
      filter.reset();
      out.push({ type: 'tracking', state: { kind: 'ok', minScore: sample.score } });
    }

    // (2) 正規化 → 平滑化
    const x = normalize(sample.raw, cal);
    if (lastT !== null && t - lastT > cfg.filterResetGapMs) {
      filter.reset(); // 長い欠測後は速度推定が壊れるのでリセットする
    }
    const xf = filter.filter(x, t / 1000);
    lastT = t;
    sessionMax = Math.max(sessionMax, xf);

    out.push({ type: 'progress', value: clamp01(xf), phase });

    // (3) 累積の更新（このフレームに入ってきた時点の phase を使う。遷移は (4) で行う）
    repMinScore = Math.min(repMinScore, sample.score);
    if (phase === 'at-bottom') {
      trough = Math.min(trough, xf);
      peak = Math.max(peak, xf);
    }

    // (4) 遷移（シュミットトリガ）
    if (phase === 'unknown') {
      // 半端な位置から数え始めない: どちらかの端に入るまで待つ。
      if (xf <= cfg.bottomThreshold) {
        enterBottom(t, xf);
      } else if (xf >= cfg.topThreshold) {
        phase = 'at-top';
        topAt = t;
      }
    } else if (phase === 'at-bottom') {
      if (xf >= cfg.topThreshold) {
        // ★ここでレップ成立。1周期の完了を待たない。
        const rep = buildRep(t, xf);
        out.push({ type: 'rep', rep });
        phase = 'at-top';
        topAt = t;
        lastRepAt = t;
        lastRepOrDiagAt = t;
      }
    } else if (phase === 'at-top') {
      if (xf <= cfg.bottomThreshold) {
        enterBottom(t, xf); // 次のレップの起点。pendingEccentricMs = t - topAt を記録する。
      }
    }

    // (5) 沈黙診断 — 信号は動いているのにレップが出ない = 閾値に届いていない。
    // 黙ってゼロを出し続けない（これが無いと「壊れている」と誤解されて詰む）。
    if (t - lastRepOrDiagAt > DIAG_SILENCE_MS && sessionMax > DIAG_MIN_OBSERVED_MAX && sessionMax < cfg.topThreshold) {
      out.push({ type: 'diagnostic', hint: 'threshold_unreachable', observedMax: sessionMax });
      lastRepOrDiagAt = t;
      sessionMax = 0;
    }

    return out;
  }

  return {
    update,
    reset(): void {
      filter.reset();
      phase = 'unknown';
      lastT = null;
      lowScoreSince = null;
      lost = false;
      abortRep();
      lastRepAt = -Infinity;
      sessionMax = 0;
      lastRepOrDiagAt = -Infinity;
    },
    snapshot(): DetectorState {
      return { phase, lost, sessionMax };
    },
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
