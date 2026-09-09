import { describe, expect, it } from 'vitest';
import {
  createElbowAngleExtractor,
  createSignalExtractor,
  createWristHeightExtractor,
  probeFrame,
} from '../src/core/detect/signal';
import type { Landmark, Landmarks } from '../src/core/types';

function lm(x: number, y: number, score = 1): Landmark {
  return { x, y, score };
}

// COCO index: 0=nose ... 5=leftShoulder,6=rightShoulder,7=leftElbow,8=rightElbow,9=leftWrist,10=rightWrist
function landmarksAt(
  at: number,
  points: Partial<Record<5 | 6 | 7 | 8 | 9 | 10, Landmark>>,
): Landmarks {
  const kp: Landmark[] = Array.from({ length: 17 }, () => lm(NaN, NaN, 0));
  for (const [idx, p] of Object.entries(points)) {
    kp[Number(idx)] = p!;
  }
  return { at, kp };
}

describe('elbow-angle extractor', () => {
  const extractor = createElbowAngleExtractor();

  it('肩・肘・手首が一直線（伸展）だと180度に近い', () => {
    const l = landmarksAt(0, {
      5: lm(100, 0), // 左肩
      7: lm(100, 100), // 左肘
      9: lm(100, 200), // 左手首（肘から見て肩と反対方向にまっすぐ）
    });
    const s = extractor.extract(l, 'left');
    expect(s).not.toBeNull();
    expect(s!.raw).toBeCloseTo(180, 0);
  });

  it('手首が肩の真横まで巻き上がっている（屈曲）と90度に近い', () => {
    const l = landmarksAt(0, {
      5: lm(100, 0),
      7: lm(100, 100),
      9: lm(200, 100), // 肘から真横に折れ曲がる
    });
    const s = extractor.extract(l, 'left');
    expect(s!.raw).toBeCloseTo(90, 0);
  });

  it('side=both は原理的に不可（設計上 null を返す）', () => {
    const l = landmarksAt(0, { 5: lm(0, 0), 7: lm(0, 1), 9: lm(0, 2), 6: lm(1, 0), 8: lm(1, 1), 10: lm(1, 2) });
    expect(extractor.extract(l, 'both')).toBeNull();
  });

  it('必要なキーポイントが欠けていると null', () => {
    const l = landmarksAt(0, { 5: lm(100, 0), 7: lm(100, 100) }); // 手首が無い
    expect(extractor.extract(l, 'left')).toBeNull();
  });

  it('score は3点の最小値になる', () => {
    const l = landmarksAt(0, {
      5: lm(100, 0, 0.9),
      7: lm(100, 100, 0.4),
      9: lm(100, 200, 0.95),
    });
    expect(extractor.extract(l, 'left')!.score).toBeCloseTo(0.4);
  });

  it('requiredKeypoints は左右の肩肘手首6点', () => {
    // Array.prototype.sort() は既定で文字列比較になる（"10" < "5"）ので数値コンパレータを渡す
    expect(extractor.requiredKeypoints.slice().sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10]);
  });
});

describe('wrist-height extractor', () => {
  const extractor = createWristHeightExtractor();

  it('腕を下げている（手首が肩より下＝画像y大）と負の値になる', () => {
    const l = landmarksAt(0, {
      5: lm(100, 0), // 肩
      7: lm(100, 50), // 肘（上腕長50px）
      9: lm(100, 150), // 手首は肩よりだいぶ下
    });
    const s = extractor.extract(l, 'left');
    expect(s!.raw).toBeLessThan(0);
  });

  it('手首が肩の高さまで上がっている（curl 完了）と0付近になる', () => {
    const l = landmarksAt(0, {
      5: lm(100, 0),
      7: lm(100, 50),
      9: lm(120, 0), // 肩と同じ高さ
    });
    const s = extractor.extract(l, 'left');
    expect(s!.raw).toBeCloseTo(0, 1);
  });

  it('上腕長で正規化されている（距離が変わってもスケール不変）', () => {
    const near = landmarksAt(0, { 5: lm(100, 0), 7: lm(100, 50), 9: lm(100, 150) }); // armLen=50
    const far = landmarksAt(0, { 5: lm(100, 0), 7: lm(100, 25), 9: lm(100, 75) }); // 距離半分、armLen=25
    // 同じ「肩から手首までの相対距離」なら raw は一致するはず
    expect(extractor.extract(near, 'left')!.raw).toBeCloseTo(extractor.extract(far, 'left')!.raw, 6);
  });

  it('side=both は左右の平均を取る', () => {
    const l = landmarksAt(0, {
      5: lm(100, 0),
      7: lm(100, 50),
      9: lm(100, 150), // 左: raw = (0-150)/50 = -3
      6: lm(200, 0),
      8: lm(200, 50),
      10: lm(200, 0), // 右: raw = (0-0)/50 = 0
    });
    const s = extractor.extract(l, 'both');
    expect(s!.raw).toBeCloseTo((-3 + 0) / 2);
  });

  it('side=both で片方の上腕長が0（推定崩れ等でarmLenが計算不能）の場合、もう片方の値を返す', () => {
    // 実際の MoveNet 出力は常に17点を返す（欠落しない）ので、「見えない」は
    // undefined ではなく armLen=0（肩と肘が同座標に潰れる）等で表現するのが現実的。
    const l = landmarksAt(0, {
      5: lm(100, 0),
      7: lm(100, 50),
      9: lm(100, 150), // 左は正常（raw = -3）
      6: lm(200, 0),
      8: lm(200, 0), // 右は肩=肘で armLen=0 → wristHeightOfArm が null を返す
      10: lm(200, 100),
    });
    const s = extractor.extract(l, 'both');
    expect(s).not.toBeNull();
    expect(s!.raw).toBeCloseTo(-3);
  });

  it('上腕長が0（異常値）だと null', () => {
    const l = landmarksAt(0, { 5: lm(100, 100), 7: lm(100, 100), 9: lm(100, 150) }); // 肩=肘
    expect(extractor.extract(l, 'left')).toBeNull();
  });
});

describe('createSignalExtractor', () => {
  it('kind に応じて正しい実装を返す', () => {
    expect(createSignalExtractor('elbow-angle').kind).toBe('elbow-angle');
    expect(createSignalExtractor('wrist-height').kind).toBe('wrist-height');
  });
});

describe('probeFrame — 両腕 + 体の向きの同時観測', () => {
  /**
   * 斜め45度想定のフレームを作る。肩は水平に shoulderSepPx 離れ、上腕は
   * 長さ 100px で真下に伸びる（＝上腕長が必ず 100 になる）ようにしておく。
   */
  function bothArms(opts: {
    readonly shoulderSepPx: number;
    readonly leftWrist: Landmark;
    readonly rightWrist: Landmark;
    readonly leftScore?: number;
    readonly rightScore?: number;
  }): Landmarks {
    const ls = opts.leftScore ?? 1;
    const rs = opts.rightScore ?? 1;
    return landmarksAt(0, {
      5: lm(0, 0, ls), // 左肩
      7: lm(0, 100, ls), // 左肘（上腕長 100）
      9: opts.leftWrist,
      6: lm(opts.shoulderSepPx, 0, rs), // 右肩
      8: lm(opts.shoulderSepPx, 100, rs), // 右肘（上腕長 100）
      10: opts.rightWrist,
    });
  }

  it('左右それぞれの信号を同時に返す', () => {
    const l = bothArms({
      shoulderSepPx: 90,
      leftWrist: lm(0, 200), // 伸展（一直線）
      rightWrist: lm(90 + 100, 100), // 屈曲（真横に折れる）
    });
    const p = probeFrame(l, 'elbow-angle');
    expect(p.left.sample?.raw).toBeCloseTo(180, 0);
    expect(p.right.sample?.raw).toBeCloseTo(90, 0);
  });

  it('肩幅/上腕長を返す（上腕長 100px、肩幅 90px → 0.9）', () => {
    const p = probeFrame(
      bothArms({ shoulderSepPx: 90, leftWrist: lm(0, 200), rightWrist: lm(90, 200) }),
      'elbow-angle',
    );
    expect(p.shoulderRatio).toBeCloseTo(0.9);
    expect(p.armLenPx).toBeCloseTo(100);
  });

  it('★カメラからの距離が変わっても肩幅比は不変（上腕長で割っているため）', () => {
    // 全体を半分のスケールにしても比は変わらない = 距離に対してスケール不変。
    const near = probeFrame(
      bothArms({ shoulderSepPx: 90, leftWrist: lm(0, 200), rightWrist: lm(90, 200) }),
      'elbow-angle',
    );
    const far = landmarksAt(0, {
      5: lm(0, 0),
      7: lm(0, 50),
      9: lm(0, 100),
      6: lm(45, 0),
      8: lm(45, 50),
      10: lm(45, 100),
    });
    expect(probeFrame(far, 'elbow-angle').shoulderRatio).toBeCloseTo(near.shoulderRatio!);
    expect(probeFrame(far, 'elbow-angle').armLenPx).toBeCloseTo(50); // 上腕長だけは半分になる
  });

  it('肩の score が低いと向きの指標は null になる（信号自体は返す）', () => {
    const p = probeFrame(
      bothArms({
        shoulderSepPx: 90,
        leftWrist: lm(0, 200, 0.9),
        rightWrist: lm(90, 200, 0.9),
        leftScore: 0.1,
        rightScore: 0.1,
      }),
      'elbow-angle',
    );
    expect(p.shoulderRatio).toBeNull();
    expect(p.left.sample).not.toBeNull(); // 信号は score 付きで返り、判定は下流に任せる
  });

  it('上腕長が0（肩と肘が同じ位置）なら向き・上腕長はどちらも null', () => {
    const degenerate = landmarksAt(0, {
      5: lm(0, 0),
      7: lm(0, 0),
      9: lm(0, 100),
      6: lm(50, 0),
      8: lm(50, 0),
      10: lm(50, 100),
    });
    const p = probeFrame(degenerate, 'elbow-angle');
    expect(p.shoulderRatio).toBeNull();
    expect(p.armLenPx).toBeNull();
  });

  it('wrist-height でも両腕を個別に返す（平均にまとめない）', () => {
    const p = probeFrame(
      bothArms({
        shoulderSepPx: 90,
        leftWrist: lm(0, 200), // 手首が肩より下 → 負
        rightWrist: lm(90, -50), // 手首が肩より上 → 正
      }),
      'wrist-height',
    );
    expect(p.left.sample!.raw).toBeCloseTo(-2.0); // (0 - 200) / 100
    expect(p.right.sample!.raw).toBeCloseTo(0.5); // (0 - (-50)) / 100
  });
});
