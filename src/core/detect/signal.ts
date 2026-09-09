import type { ArmSide, Landmark, Landmarks, SignalKind, SignalSample } from '../types';

// COCO 17点の index。sensors/pose/keypoints.ts の COCO_KEYPOINT_INDEX と同じ値だが、
// core/ の「DOM / TFJS / センサー実装への依存ゼロ」原則を守るため、ここでは独立して
// 持つ（意図的な重複。値が変わることはまず無い業界標準の定数のため実害は小さい）。
const L_SHOULDER = 5;
const R_SHOULDER = 6;
const L_ELBOW = 7;
const R_ELBOW = 8;
const L_WRIST = 9;
const R_WRIST = 10;

export interface SignalExtractor {
  readonly kind: SignalKind;
  readonly requiredKeypoints: readonly number[];
  /** 必要なキーポイントが欠けている、または 'both' が elbow-angle に渡された場合は null。 */
  extract(lm: Landmarks, side: ArmSide): SignalSample | null;
}

function armIndices(side: 'left' | 'right'): { readonly s: number; readonly e: number; readonly w: number } {
  return side === 'left'
    ? { s: L_SHOULDER, e: L_ELBOW, w: L_WRIST }
    : { s: R_SHOULDER, e: R_ELBOW, w: R_WRIST };
}

function pickArm(
  lm: Landmarks,
  side: 'left' | 'right',
): { readonly shoulder: Landmark; readonly elbow: Landmark; readonly wrist: Landmark } | null {
  const idx = armIndices(side);
  const shoulder = lm.kp[idx.s];
  const elbow = lm.kp[idx.e];
  const wrist = lm.kp[idx.w];
  if (!shoulder || !elbow || !wrist) return null;
  return { shoulder, elbow, wrist };
}

function minScoreOf(...points: readonly Landmark[]): number {
  return Math.min(...points.map((p) => p.score));
}

/** 3点のなす角（度）。b が頂点。ピクセル座標。 */
function angleDeg(a: Landmark, b: Landmark, c: Landmark): number {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return NaN;
  return (Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180) / Math.PI;
}

function armLengthPx(shoulder: Landmark, elbow: Landmark): number {
  return Math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y);
}

/**
 * 肩-肘-手首の2D角度。横/45度向きに適する。カメラが正面だと肩・肘・手首が画像上で
 * 一直線に潰れ、上端付近で角度が退化するため、'both'（両腕同時）は原理的に不可 —
 * 奥の腕が体で隠れる（設計判断は plan 参照）。
 */
export function createElbowAngleExtractor(): SignalExtractor {
  return {
    kind: 'elbow-angle',
    requiredKeypoints: [L_SHOULDER, L_ELBOW, L_WRIST, R_SHOULDER, R_ELBOW, R_WRIST],
    extract(lm: Landmarks, side: ArmSide): SignalSample | null {
      if (side === 'both') return null;
      const arm = pickArm(lm, side);
      if (!arm) return null;
      const angle = angleDeg(arm.shoulder, arm.elbow, arm.wrist);
      if (Number.isNaN(angle)) return null;
      return { at: lm.at, raw: angle, score: minScoreOf(arm.shoulder, arm.elbow, arm.wrist) };
    },
  };
}

function wristHeightOfArm(lm: Landmarks, side: 'left' | 'right'): SignalSample | null {
  const arm = pickArm(lm, side);
  if (!arm) return null;
  const armLen = armLengthPx(arm.shoulder, arm.elbow);
  if (armLen === 0) return null;
  // (肩y - 手首y) / 上腕長。画像のyは下向き正: 腕を下げているほど負に大きく、
  // curl して手首が上がるほど増える（calibration.ts の Calibration.bottomRaw/topRaw の
  // doc comment と符号の向きを揃えている）。
  const raw = (arm.shoulder.y - arm.wrist.y) / armLen;
  return { at: lm.at, raw, score: minScoreOf(arm.shoulder, arm.elbow, arm.wrist) };
}

/**
 * (肩y − 手首y) / 上腕長。正面向きに適する。上腕長で正規化しているのでカメラからの
 * 距離が変わってもスケール不変。'both'（両腕同時）は左右の平均を取ることで対応できる
 * — これが「正面カメラ + 両腕同時モード」を成立させる唯一の信号（plan 参照）。
 */
export function createWristHeightExtractor(): SignalExtractor {
  return {
    kind: 'wrist-height',
    requiredKeypoints: [L_SHOULDER, L_ELBOW, L_WRIST, R_SHOULDER, R_ELBOW, R_WRIST],
    extract(lm: Landmarks, side: ArmSide): SignalSample | null {
      if (side !== 'both') return wristHeightOfArm(lm, side);

      const left = wristHeightOfArm(lm, 'left');
      const right = wristHeightOfArm(lm, 'right');
      if (!left && !right) return null;
      if (!right) return left;
      if (!left) return right;
      return { at: lm.at, raw: (left.raw + right.raw) / 2, score: Math.min(left.score, right.score) };
    },
  };
}

export function createSignalExtractor(kind: SignalKind): SignalExtractor {
  return kind === 'elbow-angle' ? createElbowAngleExtractor() : createWristHeightExtractor();
}
