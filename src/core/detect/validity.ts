import type { Ms, RejectReason } from '../types';

export interface ValidityConfig {
  readonly minConcentricMs: Ms;
  readonly maxConcentricMs: Ms;
  readonly minEccentricMs: Ms;
  readonly minInterRepMs: Ms;
  readonly minRomRatio: number;
  readonly warnScore: number;
}

export interface ValidityInput {
  readonly concentricMs: Ms;
  /** 前レップの上端 → 今回の下端。初回レップは null（この場合 fast_eccentric は評価しない）。 */
  readonly eccentricMs: Ms | null;
  readonly romRatio: number;
  readonly repMinScore: number;
  readonly msSinceLastRep: Ms;
}

/**
 * 無効レップ判定。完全な純関数 — 「不正対策」ではなく「信号の妥当性検査
 * （ノイズ除去＋フォームゲート）」として扱う（設計判断は plan 参照）。
 *
 * 正直な注記: minRomRatio はほぼ no-op になる。bottomThreshold/topThreshold を
 * 通過したレップは定義上 ROM がその差分以上あるため、閾値そのものが ROM の本体を
 * 担っている。これは閾値を緩めた設定で使う人のための保険程度の意味。
 * 本当に効く ROM チェックはキャリブレーション側（calibration.ts の
 * validateCalibration）にある。
 */
export function evaluateRejects(input: ValidityInput, cfg: ValidityConfig): RejectReason[] {
  const rejects: RejectReason[] = [];
  if (input.concentricMs < cfg.minConcentricMs) rejects.push('too_fast');
  if (input.concentricMs > cfg.maxConcentricMs) rejects.push('too_slow');
  if (input.romRatio < cfg.minRomRatio) rejects.push('short_rom');
  if (input.repMinScore < cfg.warnScore) rejects.push('low_confidence');
  if (input.msSinceLastRep < cfg.minInterRepMs) rejects.push('chatter');
  // エキセントリック（下ろす動作）が速すぎる = 重力任せ = 怪我リスク。これが実質的な
  // 「速度上限」の実体（テンポゲート）。初回レップ（前回の上端が無い）は評価しない。
  if (input.eccentricMs !== null && input.eccentricMs < cfg.minEccentricMs) {
    rejects.push('fast_eccentric');
  }
  return rejects;
}
