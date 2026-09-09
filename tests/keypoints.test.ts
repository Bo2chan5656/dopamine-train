import { describe, expect, it } from 'vitest';
import {
  armLengthPx,
  COCO_KEYPOINT_INDEX,
  getArmKeypoints,
  minScore,
  toPixelKeypoints,
} from '../src/sensors/pose/keypoints';

describe('toPixelKeypoints', () => {
  it('score が欠落している要素は 0 として正規化する', () => {
    const result = toPixelKeypoints([
      { x: 1, y: 2, score: 0.5 },
      { x: 3, y: 4 }, // score 無し
    ]);
    expect(result).toEqual([
      { x: 1, y: 2, score: 0.5 },
      { x: 3, y: 4, score: 0 },
    ]);
  });
});

describe('getArmKeypoints', () => {
  function buildKeypoints(): { x: number; y: number; score: number }[] {
    return Array.from({ length: 17 }, (_, i) => ({ x: i, y: i * 2, score: 0.9 }));
  }

  it('left は COCO index 5/7/9 を返す', () => {
    const kp = buildKeypoints();
    const arm = getArmKeypoints(kp, 'left');
    expect(arm).toEqual({
      shoulder: kp[COCO_KEYPOINT_INDEX.leftShoulder],
      elbow: kp[COCO_KEYPOINT_INDEX.leftElbow],
      wrist: kp[COCO_KEYPOINT_INDEX.leftWrist],
    });
  });

  it('right は COCO index 6/8/10 を返す', () => {
    const kp = buildKeypoints();
    const arm = getArmKeypoints(kp, 'right');
    expect(arm).toEqual({
      shoulder: kp[COCO_KEYPOINT_INDEX.rightShoulder],
      elbow: kp[COCO_KEYPOINT_INDEX.rightElbow],
      wrist: kp[COCO_KEYPOINT_INDEX.rightWrist],
    });
  });

  it('配列が短く該当 index が無い場合は null', () => {
    const kp = buildKeypoints().slice(0, 5); // 手首(9)まで届かない
    expect(getArmKeypoints(kp, 'left')).toBeNull();
  });
});

describe('minScore', () => {
  it('複数点の最小値を返す', () => {
    expect(
      minScore({ x: 0, y: 0, score: 0.9 }, { x: 0, y: 0, score: 0.3 }, { x: 0, y: 0, score: 0.7 }),
    ).toBeCloseTo(0.3);
  });

  it('引数が無ければ 0', () => {
    expect(minScore()).toBe(0);
  });
});

describe('armLengthPx', () => {
  it('肩肘のピクセル距離（3-4-5の直角三角形）', () => {
    const shoulder = { x: 0, y: 0, score: 1 };
    const elbow = { x: 3, y: 4, score: 1 };
    expect(armLengthPx(shoulder, elbow)).toBeCloseTo(5);
  });

  it('同座標なら0', () => {
    const p = { x: 10, y: 10, score: 1 };
    expect(armLengthPx(p, p)).toBe(0);
  });
});
