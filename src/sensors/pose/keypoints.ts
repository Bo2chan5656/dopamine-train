// MoveNet（COCO 17点）のキーポイント index。
// 公式ソース（pose-detection/src/constants.ts の COCO_KEYPOINTS）で確認済み。
export const COCO_KEYPOINT_INDEX = {
  nose: 0,
  leftEye: 1,
  rightEye: 2,
  leftEar: 3,
  rightEar: 4,
  leftShoulder: 5,
  rightShoulder: 6,
  leftElbow: 7,
  rightElbow: 8,
  leftWrist: 9,
  rightWrist: 10,
  leftHip: 11,
  rightHip: 12,
  leftKnee: 13,
  rightKnee: 14,
  leftAnkle: 15,
  rightAnkle: 16,
} as const;

/** MoveNet 内部の閾値（0.2〜0.3）より高めに要求する。角度計算に使う3点すべてに課す。 */
export const RECOMMENDED_MIN_SCORE = 0.35;

export interface PixelKeypoint {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

/** pose-detection の Pose.keypoints（score が optional）から、score 欠落を 0 として正規化する。 */
export function toPixelKeypoints(
  keypoints: ReadonlyArray<{ readonly x: number; readonly y: number; readonly score?: number }>,
): PixelKeypoint[] {
  return keypoints.map((k) => ({ x: k.x, y: k.y, score: k.score ?? 0 }));
}

export interface ArmKeypoints {
  readonly shoulder: PixelKeypoint;
  readonly elbow: PixelKeypoint;
  readonly wrist: PixelKeypoint;
}

/** 'left'|'right' の肩・肘・手首を取り出す。いずれかの index が欠けていたら null。 */
export function getArmKeypoints(keypoints: readonly PixelKeypoint[], side: 'left' | 'right'): ArmKeypoints | null {
  const idx =
    side === 'left'
      ? { shoulder: COCO_KEYPOINT_INDEX.leftShoulder, elbow: COCO_KEYPOINT_INDEX.leftElbow, wrist: COCO_KEYPOINT_INDEX.leftWrist }
      : { shoulder: COCO_KEYPOINT_INDEX.rightShoulder, elbow: COCO_KEYPOINT_INDEX.rightElbow, wrist: COCO_KEYPOINT_INDEX.rightWrist };
  const shoulder = keypoints[idx.shoulder];
  const elbow = keypoints[idx.elbow];
  const wrist = keypoints[idx.wrist];
  if (!shoulder || !elbow || !wrist) return null;
  return { shoulder, elbow, wrist };
}

/** 与えたキーポイント群の最小 score。信号抽出の信頼度ゲートに使う。 */
export function minScore(...points: readonly PixelKeypoint[]): number {
  if (points.length === 0) return 0;
  return Math.min(...points.map((p) => p.score));
}

/** 上腕長（肩-肘のピクセル距離）。wrist-height 信号の正規化とキャリブレーション診断に使う。 */
export function armLengthPx(shoulder: PixelKeypoint, elbow: PixelKeypoint): number {
  return Math.hypot(shoulder.x - elbow.x, shoulder.y - elbow.y);
}
