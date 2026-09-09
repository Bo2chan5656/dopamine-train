import type { ArmSide, Landmark, Landmarks, Ms, SignalKind, SignalSample } from '../types';

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

// ---------------------------------------------------------------------------
// キャリブレーション用のフレーム観測
// ---------------------------------------------------------------------------

export type JointName = 'shoulder' | 'elbow' | 'wrist';

/** 肩・肘・手首それぞれの値（score や「画面外だったか」を関節別に運ぶ器）。 */
export interface JointValues {
  readonly shoulder: number;
  readonly elbow: number;
  readonly wrist: number;
}

export const JOINT_NAMES: readonly JointName[] = ['shoulder', 'elbow', 'wrist'];

/** 映像のサイズ。キーポイントが画面外に出ているかの判定に使う。 */
export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 片腕1フレーム分の観測。
 *
 * ★ scores を関節別に持つのが要点。SignalSample.score は
 * min(肩, 肘, 手首) に潰れているため、「体がよく見えていません」が出たときに
 * **どの関節が原因なのか特定できない**（実際に詰まった）。手首なのか肩なのかで
 * 対処（距離を変える / 袖の色 / 画角の上下）が全く違うので、分解して持つ。
 */
export interface ArmProbe {
  readonly sample: SignalSample | null;
  /** 関節ごとの score。腕の信号が取れなくても score 自体は分かるので常に入る。 */
  readonly scores: JointValues;
  /** 関節ごとに「画面外（または画面端）にいたか」。1 = 外、0 = 内。 */
  readonly outside: JointValues;
}

/**
 * 1フレームから「両腕の信号」と「体の向きの指標」を同時に取り出したもの。
 *
 * ★ キャリブレーションが片腕を決め打ちしないために必要。カメラを体の左斜め45度に
 * 置いた場合、カメラに近いのは左腕で、右腕は体で隠れる（その逆も同様）。どちらの
 * 腕を使うかは「宣言」ではなく「両方測って良い方を選ぶ」で決めるほうが確実。
 */
export interface FrameProbe {
  readonly at: Ms;
  readonly left: ArmProbe;
  readonly right: ArmProbe;
  /**
   * 肩幅（画像上の左右肩の水平距離）/ 上腕長。カメラに対する体の向きの指標。
   * 正面を向くと両肩が左右に開いて大きく、横を向くと画像上で重なって 0 に近づく。
   * 上腕長で割ることで、カメラからの距離に対してスケール不変になる。
   * 肩が取れない場合は null。
   */
  readonly shoulderRatio: number | null;
  /** 上腕長（ピクセル）。距離・フレーミングの診断に使う。取れなければ null。 */
  readonly armLenPx: number | null;
}

/** 向きの指標に使う肩の最低 score。これを割るフレームは指標を出さない（null）。 */
const MIN_SHOULDER_SCORE_FOR_RATIO = 0.3;

/**
 * 「画面端」とみなす余白（幅/高さに対する割合）。完全に外に出ていなくても、
 * 端から2%以内にあるキーポイントは切れかけとして扱う — 腕を下ろしたときに
 * 手首が画面下端に来るケースを拾うのが目的。
 */
const EDGE_MARGIN_RATIO = 0.02;

function isOutside(p: Landmark | undefined, frame: FrameSize | null): number {
  if (!p) return 1;
  if (!frame || frame.width <= 0 || frame.height <= 0) return 0; // 判定材料が無い
  const mx = frame.width * EDGE_MARGIN_RATIO;
  const my = frame.height * EDGE_MARGIN_RATIO;
  const out = p.x < mx || p.x > frame.width - mx || p.y < my || p.y > frame.height - my;
  return out ? 1 : 0;
}

function armProbe(
  lm: Landmarks,
  side: 'left' | 'right',
  extractor: SignalExtractor,
  frame: FrameSize | null,
): ArmProbe {
  const idx = armIndices(side);
  const shoulder = lm.kp[idx.s];
  const elbow = lm.kp[idx.e];
  const wrist = lm.kp[idx.w];
  return {
    sample: extractor.extract(lm, side),
    scores: {
      shoulder: shoulder?.score ?? 0,
      elbow: elbow?.score ?? 0,
      wrist: wrist?.score ?? 0,
    },
    outside: {
      shoulder: isOutside(shoulder, frame),
      elbow: isOutside(elbow, frame),
      wrist: isOutside(wrist, frame),
    },
  };
}

/**
 * キャリブレーション記録中に毎フレーム呼ぶ観測関数。指定された signal の抽出を
 * 左右それぞれに対して行い、あわせて関節別の score・画面外判定・向き・上腕長も測る。
 *
 * frame（映像サイズ）は省略可。渡さない場合は画面外判定を行わない（0 固定）。
 */
export function probeFrame(lm: Landmarks, signal: SignalKind, frame: FrameSize | null = null): FrameProbe {
  const extractor = createSignalExtractor(signal);
  const leftShoulder = lm.kp[L_SHOULDER];
  const rightShoulder = lm.kp[R_SHOULDER];

  // 上腕長は左右で取れた方の大きい値を使う。奥の腕は遠近で短く写る（foreshortening）
  // ので、max を取るほうが「実際の上腕の長さ」に近い値になる。
  const leftArm = pickArm(lm, 'left');
  const rightArm = pickArm(lm, 'right');
  const lengths = [
    leftArm ? armLengthPx(leftArm.shoulder, leftArm.elbow) : 0,
    rightArm ? armLengthPx(rightArm.shoulder, rightArm.elbow) : 0,
  ];
  const armLen = Math.max(...lengths);

  const shouldersVisible =
    !!leftShoulder &&
    !!rightShoulder &&
    leftShoulder.score >= MIN_SHOULDER_SCORE_FOR_RATIO &&
    rightShoulder.score >= MIN_SHOULDER_SCORE_FOR_RATIO;

  return {
    at: lm.at,
    left: armProbe(lm, 'left', extractor, frame),
    right: armProbe(lm, 'right', extractor, frame),
    shoulderRatio:
      shouldersVisible && armLen > 0 ? Math.abs(leftShoulder.x - rightShoulder.x) / armLen : null,
    armLenPx: armLen > 0 ? armLen : null,
  };
}
