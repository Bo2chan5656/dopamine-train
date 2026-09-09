import type { ArmSide, CameraView, SignalKind, SignalSample } from '../types';

export interface CalibrationSample {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly minScore: number;
  readonly frames: number;
}

export interface Calibration {
  readonly signal: SignalKind;
  readonly side: ArmSide;
  readonly view: CameraView;
  /**
   * 伸展側（下端）の代表値。符号の向きは signal ごとに異なる:
   *   - elbow-angle:   伸展で角度が大きい → bottomRaw > topRaw
   *   - wrist-height:  (肩y − 手首y)/上腕長。画像のyは下向き正なので、
   *                    腕を下げている(手首が肩より下＝手首yが大きい)ほど値は負に大きく、
   *                    curl して手首が肩に近づく/上がるほど値は増える → topRaw > bottomRaw
   * normalize() はこの向きに依存しない（単純な逆線形補間）が、
   * validateCalibration() の「inverted」判定はこの向きを知っている必要がある。
   */
  readonly bottomRaw: number;
  readonly topRaw: number; // 屈曲側（上端）の代表値
  /**
   * 記録時の上腕長（診断用ピクセル値。例: dev panel に表示する）。
   * ★ ROM チェックには使わない — wrist-height の raw 値は
   * 「(肩y-手首y)/armLenPx」の時点で既に上腕長で割った比率になっているため、
   * ここでもう一度 armLenPx を掛けると二重に正規化してしまう。
   */
  readonly armLenPx: number;
  readonly createdAt: number; // Date.now()
}

export type CalibrationRejectReason = 'rom_too_small' | 'low_confidence' | 'inverted';
export type CalibrationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CalibrationRejectReason };

const MIN_FRAMES_FOR_SUMMARY = 3;
const MIN_SCORE_FOR_CALIBRATION = 0.5;
const MIN_ROM_DEGREES = 60; // elbow-angle: |top - bottom| >= 60°
// wrist-height: raw は既に「上腕長に対する比率」なので、しきい値も比率のまま（
// armLenPx を掛け直さない）。|top - bottom| >= 0.8 本分の上腕長分は動いていること。
const MIN_ROM_ARM_LENGTH_RATIO = 0.8;

/**
 * 1秒窓のサンプル列 → ロバストな代表値。min/max ではなく p10/p50/p90（percentile）を
 * 使う — 一瞬の誤検出フレーム1つに代表値が引きずられないようにするため。
 */
export function summarize(samples: readonly SignalSample[]): CalibrationSample {
  if (samples.length === 0) {
    return { p10: NaN, p50: NaN, p90: NaN, minScore: 0, frames: 0 };
  }
  // map() は新しい配列を返すので、元の samples を破壊せずそのまま sort() してよい。
  const raws = samples.map((s) => s.raw).sort((a, b) => a - b);
  const minScore = Math.min(...samples.map((s) => s.score));
  return {
    p10: percentile(raws, 0.1),
    p50: percentile(raws, 0.5),
    p90: percentile(raws, 0.9),
    minScore,
    frames: samples.length,
  };
}

function percentile(sortedAsc: readonly number[], p: number): number {
  const last = sortedAsc.length - 1;
  if (last === 0) return sortedAsc[0]!;
  const idx = p * last;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sortedAsc[lo]!;
  if (lo === hi) return loVal;
  const hiVal = sortedAsc[hi]!;
  return loVal + (hiVal - loVal) * (idx - lo);
}

/** 0 = 下端, 1 = 上端。範囲外は [-0.5, 1.5] にクランプする（信号方向に依存しない逆線形補間）。 */
export function normalize(raw: number, cal: Calibration): number {
  const span = cal.topRaw - cal.bottomRaw;
  if (span === 0) return 0.5; // 壊れたキャリブレーション。validateCalibration で弾かれているはず
  const v = (raw - cal.bottomRaw) / span;
  return Math.max(-0.5, Math.min(1.5, v));
}

/** normalize() の逆演算。テスト用の合成信号生成や、設定画面の閾値プレビュー等に使う。 */
export function denormalize(norm: number, cal: Calibration): number {
  return cal.bottomRaw + norm * (cal.topRaw - cal.bottomRaw);
}

function isCorrectDirection(cal: Calibration): boolean {
  // signal ごとの符号の向きは Calibration の doc comment を参照。
  return cal.signal === 'elbow-angle' ? cal.bottomRaw > cal.topRaw : cal.topRaw > cal.bottomRaw;
}

/**
 * キャリブレーション受理条件。ここが実質的な「唯一の不正対策」— 手首をちょこちょこ
 * 振る動きで上端/下端を登録すれば、正規化後は完璧なフルレップに見えてしまうため、
 * ここで ROM の絶対量と信頼度を担保する。これを塞げば下流（validity.ts）の
 * ROM チェックはほぼ自動的に満たされる。
 */
export function validateCalibration(
  cal: Calibration,
  s: { readonly bottom: CalibrationSample; readonly top: CalibrationSample },
): CalibrationValidation {
  if (
    s.bottom.frames < MIN_FRAMES_FOR_SUMMARY ||
    s.top.frames < MIN_FRAMES_FOR_SUMMARY ||
    s.bottom.minScore < MIN_SCORE_FOR_CALIBRATION ||
    s.top.minScore < MIN_SCORE_FOR_CALIBRATION
  ) {
    return { ok: false, reason: 'low_confidence' };
  }

  const rom = Math.abs(cal.topRaw - cal.bottomRaw);
  const minRom = cal.signal === 'elbow-angle' ? MIN_ROM_DEGREES : MIN_ROM_ARM_LENGTH_RATIO;
  if (rom < minRom) {
    return { ok: false, reason: 'rom_too_small' };
  }

  if (!isCorrectDirection(cal)) {
    return { ok: false, reason: 'inverted' };
  }

  return { ok: true };
}
