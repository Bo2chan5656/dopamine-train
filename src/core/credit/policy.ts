import type { Ms } from '../types';

/**
 * 視聴クレジットの報酬設計（バンキング方式）。'per-slide'（1レップ1スライド）は
 * 将来の選択肢として型に残すが、今回は 'bank' のみ実装する。
 */
export interface CreditPolicy {
  readonly repsPerGrant: number; // N 既定 10
  readonly secondsPerGrant: number; // X 既定 60
  readonly maxBankedSeconds: number; // 既定 600（貯め込み防止）
  readonly creditExpiryMs: Ms | null; // 既定 30分（放置クレジットは失効）。null で無効化
  readonly dailyRepCap: number; // 既定 300 ← 実質の日次視聴上限
  readonly lowWarningSeconds: number; // 既定 10
  readonly grant: 'bank'; // 'per-slide' は将来。今は実装しない
}

export const DEFAULT_POLICY: CreditPolicy = {
  repsPerGrant: 10,
  secondsPerGrant: 60,
  maxBankedSeconds: 600,
  creditExpiryMs: 30 * 60 * 1000,
  dailyRepCap: 300,
  lowWarningSeconds: 10,
  grant: 'bank',
};

/**
 * 設定パネル / localStorage からの入力を安全な範囲にクランプする。
 * 入力元は自分の設定パネルと localStorage だけなので、zod 等のスキーマ検証は使わない
 * （手書きのクランプで十分。過剰設計を避ける）。
 */
export function clampPolicy(patch: Partial<CreditPolicy>): CreditPolicy {
  const merged = { ...DEFAULT_POLICY, ...patch };

  const secondsPerGrant = clampInt(merged.secondsPerGrant, 1, 3600);
  return {
    repsPerGrant: clampInt(merged.repsPerGrant, 1, 100),
    secondsPerGrant,
    // 銀行の上限が1回分の付与額を下回ると、報酬が付与された瞬間に消え去る
    // （体験が「壊れている」ようにしか見えない）ので、下限を secondsPerGrant に固定する。
    maxBankedSeconds: clampInt(merged.maxBankedSeconds, secondsPerGrant, 24 * 3600),
    creditExpiryMs:
      merged.creditExpiryMs === null ? null : clampInt(merged.creditExpiryMs, 60_000, 24 * 3600_000),
    dailyRepCap: clampInt(merged.dailyRepCap, 0, 10_000),
    lowWarningSeconds: clampInt(merged.lowWarningSeconds, 0, secondsPerGrant),
    grant: 'bank',
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
