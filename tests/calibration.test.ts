import { describe, expect, it } from 'vitest';
import {
  classifyView,
  denormalize,
  normalize,
  resolveCalibration,
  summarize,
  summarizeCapture,
  type ArmCapture,
  type Calibration,
} from '../src/core/detect/calibration';
import type { ArmProbe, FrameProbe } from '../src/core/detect/signal';
import type { SignalSample } from '../src/core/types';

function elbowCal(overrides: Partial<Calibration> = {}): Calibration {
  return {
    signal: 'elbow-angle',
    side: 'right',
    view: 'side45',
    bottomRaw: 160, // 伸展（大きい角度）
    topRaw: 40, // 屈曲（小さい角度）
    armLenPx: 200,
    createdAt: 0,
    ...overrides,
  };
}

function wristCal(overrides: Partial<Calibration> = {}): Calibration {
  return {
    signal: 'wrist-height',
    side: 'both',
    view: 'front',
    bottomRaw: -1.2, // 腕を下げている（肩y-手首y が大きく負）
    topRaw: 0.3, // 巻き上げている（肩y-手首y が正寄り）
    armLenPx: 150,
    createdAt: 0,
    ...overrides,
  };
}

function sample(raw: number, score = 1, at = 0): SignalSample {
  return { at, raw, score };
}

interface ArmSpec {
  readonly raw: number;
  readonly score?: number;
  /** この腕が検出できたフレーム数。既定は frames と同じ（＝全フレーム検出）。 */
  readonly detectedFrames?: number;
}

/**
 * 1ステップ分の記録を合成する。summarizeCapture 経由で作るので、
 * 「代表値の集約」と「候補の選択」を通しでテストできる。
 */
function makeCapture(cfg: {
  readonly left?: ArmSpec;
  readonly right?: ArmSpec;
  readonly shoulderRatio?: number;
  readonly armLenPx?: number;
  readonly frames?: number;
  readonly dropped?: number;
  /** 手首が画面外だったフレームの割合を模す（0 or 1）。 */
  readonly wristOutside?: number;
}): ArmCapture {
  const frames = cfg.frames ?? 24;
  const probes: FrameProbe[] = Array.from({ length: frames }, (_, i) => {
    const at = i * 40;
    const arm = (spec: ArmSpec | undefined): ArmProbe => {
      const detected = !!spec && i < (spec.detectedFrames ?? frames);
      const score = spec?.score ?? 0.9;
      return {
        sample: detected && spec ? { at, raw: spec.raw, score } : null,
        // 関節別 score は「腕全体の score」と同じ値を3関節に入れておく
        // （左右・ROM の選択ロジックの検証が目的で、関節別の内訳は
        //  signal.test.ts の probeFrame 側で検証する）。
        scores: { shoulder: score, elbow: score, wrist: score },
        outside: { shoulder: 0, elbow: 0, wrist: cfg.wristOutside ?? 0 },
      };
    };
    return {
      at,
      left: arm(cfg.left),
      right: arm(cfg.right),
      shoulderRatio: cfg.shoulderRatio ?? 0.9, // 斜め45度相当
      armLenPx: cfg.armLenPx ?? 60,
    };
  });
  return summarizeCapture(probes, cfg.dropped ?? 0);
}

describe('summarize', () => {
  it('外れ値1フレームで p10/p90 が壊れない（中央値付近のクラスタから大きく動かない）', () => {
    const cluster = Array.from({ length: 29 }, (_, i) => sample(100 + (i % 3))); // 100..102 に密集
    const outlier = [sample(9999)]; // 明らかな外れ値1つ
    const s = summarize([...cluster, ...outlier]);
    expect(s.p10).toBeLessThan(200);
    expect(s.p50).toBeLessThan(200);
    // p90 は外れ値の影響をある程度受けるが、max(9999) そのものにはならない
    expect(s.p90).toBeLessThan(9999);
  });

  it('★1フレームだけ信頼度が落ちても scoreP10 は下がらない（scoreMin には現れる）', () => {
    // これが「厳しすぎるキャリブレーション」の修正点。最小値で判定していた頃は
    // この1フレームだけで low_confidence 確定になっていた。
    const samples = [...Array.from({ length: 23 }, () => sample(100, 0.9)), sample(100, 0.05)];
    const s = summarize(samples);
    expect(s.scoreP10).toBeCloseTo(0.9);
    expect(s.scoreMin).toBeCloseTo(0.05);
  });

  it('信頼度が全体的に低ければ scoreP10 もちゃんと低い（緩めすぎていない）', () => {
    const s = summarize(Array.from({ length: 24 }, () => sample(100, 0.2)));
    expect(s.scoreP10).toBeCloseTo(0.2);
  });

  it('半分が低信頼度なら scoreP10 は低い方に張り付く', () => {
    const samples = [
      ...Array.from({ length: 12 }, () => sample(100, 0.9)),
      ...Array.from({ length: 12 }, () => sample(100, 0.1)),
    ];
    expect(summarize(samples).scoreP10).toBeCloseTo(0.1);
  });

  it('空配列は frames:0 を返し例外を投げない', () => {
    expect(summarize([]).frames).toBe(0);
  });

  it('1件だけでも percentile 計算が破綻しない', () => {
    const s = summarize([sample(42, 0.8)]);
    expect(s.p10).toBe(42);
    expect(s.p50).toBe(42);
    expect(s.p90).toBe(42);
    expect(s.scoreP10).toBe(0.8);
  });
});

describe('summarizeCapture', () => {
  it('姿勢が取れなかったフレームは代表値に混ざらず droppedFrames で数える', () => {
    // ★これが以前のバグ。score:0 のダミーサンプルが記録バッファに入っていたため、
    // 1フレーム落ちるだけで minScore=0 → low_confidence 確定になっていた。
    const c = makeCapture({ right: { raw: 160, score: 0.9 }, dropped: 5 });
    expect(c.droppedFrames).toBe(5);
    expect(c.right.scoreP10).toBeCloseTo(0.9); // 0 に引きずられない
    expect(c.right.p50).toBeCloseTo(160);
  });

  it('片腕だけ検出できたフレームは、その腕の frames にだけ計上される', () => {
    const c = makeCapture({
      right: { raw: 160 },
      left: { raw: 150, detectedFrames: 4 }, // 左腕は4フレームしか見えなかった
      frames: 24,
    });
    expect(c.right.frames).toBe(24);
    expect(c.left.frames).toBe(4);
  });

  it('肩幅比と上腕長も集約される（距離・向きの診断用）', () => {
    const c = makeCapture({ right: { raw: 160 }, shoulderRatio: 0.85, armLenPx: 72 });
    expect(c.shoulderRatio.p50).toBeCloseTo(0.85);
    expect(c.armLenPx.p50).toBeCloseTo(72);
  });
});

describe('classifyView', () => {
  it('肩が左右に大きく開いていれば正面', () => {
    expect(classifyView(1.4)).toBe('front');
  });
  it('中間なら斜め45度', () => {
    expect(classifyView(0.9)).toBe('side45');
    expect(classifyView(0.5)).toBe('side45');
  });
  it('肩が画像上で重なっていればほぼ真横', () => {
    expect(classifyView(0.1)).toBe('side');
  });
  it('値が取れない（NaN）場合は side45 に倒す', () => {
    expect(classifyView(NaN)).toBe('side45');
  });
});

describe('normalize / denormalize', () => {
  it('elbow-angle: 下端(bottomRaw)で0、上端(topRaw)で1になる', () => {
    const cal = elbowCal();
    expect(normalize(cal.bottomRaw, cal)).toBeCloseTo(0);
    expect(normalize(cal.topRaw, cal)).toBeCloseTo(1);
    expect(normalize((cal.bottomRaw + cal.topRaw) / 2, cal)).toBeCloseTo(0.5);
  });

  it('wrist-height: 符号の向きが逆でも0/1に正しく対応する', () => {
    const cal = wristCal();
    expect(normalize(cal.bottomRaw, cal)).toBeCloseTo(0);
    expect(normalize(cal.topRaw, cal)).toBeCloseTo(1);
  });

  it('範囲外は [-0.5, 1.5] にクランプされる', () => {
    const cal = elbowCal(); // bottom=160, top=40, span=-120
    expect(normalize(280, cal)).toBeCloseTo(-0.5);
    expect(normalize(-80, cal)).toBeCloseTo(1.5);
  });

  it('denormalize は normalize の逆演算になる', () => {
    const cal = wristCal();
    for (const n of [0, 0.25, 0.5, 0.75, 1]) {
      expect(normalize(denormalize(n, cal), cal)).toBeCloseTo(n, 6);
    }
  });

  it('span が 0（壊れたキャリブレーション）でも例外を投げず 0.5 を返す', () => {
    const cal = elbowCal({ bottomRaw: 100, topRaw: 100 });
    expect(normalize(100, cal)).toBe(0.5);
  });
});

describe('resolveCalibration — 左右の自動選択', () => {
  it('★カメラが体の右斜め45度: 右腕が選ばれる', () => {
    // 右腕はよく見えて大きく動く。左腕は体に隠れて信頼度が低く、ほぼ動かない。
    const bottom = makeCapture({ right: { raw: 165, score: 0.9 }, left: { raw: 150, score: 0.2 } });
    const top = makeCapture({ right: { raw: 45, score: 0.9 }, left: { raw: 148, score: 0.2 } });
    const r = resolveCalibration('elbow-angle', bottom, top, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calibration.side).toBe('right');
    expect(r.calibration.bottomRaw).toBeCloseTo(165);
    expect(r.calibration.topRaw).toBeCloseTo(45);
  });

  it('★カメラが体の左斜め45度: 左腕が選ばれる（同じ手順のまま通る）', () => {
    const bottom = makeCapture({ left: { raw: 168, score: 0.88 }, right: { raw: 150, score: 0.15 } });
    const top = makeCapture({ left: { raw: 42, score: 0.88 }, right: { raw: 148, score: 0.15 } });
    const r = resolveCalibration('elbow-angle', bottom, top, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calibration.side).toBe('left');
    expect(r.calibration.bottomRaw).toBeCloseTo(168);
  });

  it('両腕とも条件を満たす場合は ROM が大きい方を選ぶ', () => {
    const bottom = makeCapture({ left: { raw: 160 }, right: { raw: 160 } });
    const top = makeCapture({ left: { raw: 90 }, right: { raw: 30 } }); // 右のほうが大きく動いた
    const r = resolveCalibration('elbow-angle', bottom, top, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calibration.side).toBe('right');
  });

  it('推定した向きが Calibration に入る（宣言ではなく実測値）', () => {
    const bottom = makeCapture({ right: { raw: 165 }, shoulderRatio: 1.5 });
    const top = makeCapture({ right: { raw: 45 }, shoulderRatio: 1.5 });
    const r = resolveCalibration('elbow-angle', bottom, top, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calibration.view).toBe('front'); // 肩幅比 1.5 → 正面
    expect(r.diagnostics.shoulderRatio).toBeCloseTo(1.5);
  });

  it('向きの推定では受理を拒否しない（しきい値が実機未検証なのでゲートにしない）', () => {
    // 正面向きと判定されても、ROM と信頼度が足りていれば通る。
    const bottom = makeCapture({ right: { raw: 165 }, shoulderRatio: 2.0 });
    const top = makeCapture({ right: { raw: 45 }, shoulderRatio: 2.0 });
    expect(resolveCalibration('elbow-angle', bottom, top, 1000).ok).toBe(true);
  });

  it('動かしたのが奥側の腕だけ → rom_too_small（手前の腕は動いていない）', () => {
    // 手前(右)は信頼度は高いが動いていない。奥(左)は動いたが隠れて信頼度が低い。
    const bottom = makeCapture({ right: { raw: 160, score: 0.9 }, left: { raw: 165, score: 0.2 } });
    const top = makeCapture({ right: { raw: 158, score: 0.9 }, left: { raw: 45, score: 0.2 } });
    const r = resolveCalibration('elbow-angle', bottom, top, 1000);
    expect(r).toMatchObject({ ok: false, reason: 'rom_too_small' });
  });

  it('ROM が小さすぎる（手首をちょこちょこ振っただけ）と rom_too_small', () => {
    const bottom = makeCapture({ right: { raw: 100 }, left: { raw: 100 } });
    const top = makeCapture({ right: { raw: 90 }, left: { raw: 90 } }); // 差10° < 60°
    expect(resolveCalibration('elbow-angle', bottom, top, 1000)).toMatchObject({
      ok: false,
      reason: 'rom_too_small',
    });
  });

  it('伸展と屈曲を逆の順で記録すると inverted', () => {
    const bottom = makeCapture({ right: { raw: 40 }, left: { raw: 40 } }); // 巻き上げた状態を先に
    const top = makeCapture({ right: { raw: 160 }, left: { raw: 160 } });
    expect(resolveCalibration('elbow-angle', bottom, top, 1000)).toMatchObject({
      ok: false,
      reason: 'inverted',
    });
  });

  it('両腕とも信頼度が低ければ low_confidence', () => {
    const bottom = makeCapture({ right: { raw: 165, score: 0.2 }, left: { raw: 165, score: 0.2 } });
    const top = makeCapture({ right: { raw: 45, score: 0.2 }, left: { raw: 45, score: 0.2 } });
    expect(resolveCalibration('elbow-angle', bottom, top, 1000)).toMatchObject({
      ok: false,
      reason: 'low_confidence',
    });
  });

  it('人物が映っていない（フレームが取れていない）と no_frames', () => {
    const empty = makeCapture({ frames: 24, dropped: 24 }); // left/right とも null
    expect(resolveCalibration('elbow-angle', empty, empty, 1000)).toMatchObject({
      ok: false,
      reason: 'no_frames',
    });
  });

  it('記録フレーム数が少なすぎる場合も no_frames', () => {
    const bottom = makeCapture({ right: { raw: 165 }, frames: 2 });
    const top = makeCapture({ right: { raw: 45 }, frames: 2 });
    expect(resolveCalibration('elbow-angle', bottom, top, 1000)).toMatchObject({
      ok: false,
      reason: 'no_frames',
    });
  });

  it('wrist-height でも動作し、しきい値は上腕長比の 0.8（armLenPx を掛け直さない）', () => {
    // |top - bottom| = 0.7 < 0.8 → 不足。armLenPx がいくつでも結果は変わらない。
    const bottom = makeCapture({ right: { raw: -0.5 }, armLenPx: 999 });
    const top = makeCapture({ right: { raw: 0.2 }, armLenPx: 999 });
    expect(resolveCalibration('wrist-height', bottom, top, 1000)).toMatchObject({
      ok: false,
      reason: 'rom_too_small',
    });

    // 1.5 なら通る。wrist-height は「上げるほど増える」向き。
    const okTop = makeCapture({ right: { raw: 1.0 }, armLenPx: 999 });
    expect(resolveCalibration('wrist-height', bottom, okTop, 1000).ok).toBe(true);
  });

  it('診断情報に両腕の候補が必ず入る（失敗時に何が足りないか見せるため）', () => {
    const bottom = makeCapture({ right: { raw: 100 }, left: { raw: 100 } });
    const top = makeCapture({ right: { raw: 95 }, left: { raw: 95 } });
    const r = resolveCalibration('elbow-angle', bottom, top, 1000);
    expect(r.diagnostics.candidates).toHaveLength(2);
    expect(r.diagnostics.candidates.map((c) => c.side)).toEqual(['left', 'right']);
    for (const c of r.diagnostics.candidates) {
      expect(c.confidenceOk).toBe(true);
      expect(c.romOk).toBe(false);
    }
  });

  it('createdAt に渡した壁時計がそのまま入る', () => {
    const bottom = makeCapture({ right: { raw: 165 } });
    const top = makeCapture({ right: { raw: 45 } });
    const r = resolveCalibration('elbow-angle', bottom, top, 1234567);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calibration.createdAt).toBe(1234567);
  });
});

describe('関節別の内訳（「体がよく見えていません」の原因特定）', () => {
  /** 関節ごとに別々の score を持つ記録を作る */
  function captureWithJoints(j: {
    readonly shoulder: number;
    readonly elbow: number;
    readonly wrist: number;
    readonly wristOutsideRatio?: number;
    readonly raw?: number;
  }): ArmCapture {
    const frames = 24;
    const outsideFrames = Math.round((j.wristOutsideRatio ?? 0) * frames);
    const probes: FrameProbe[] = Array.from({ length: frames }, (_, i) => {
      const armScore = Math.min(j.shoulder, j.elbow, j.wrist);
      const arm: ArmProbe = {
        sample: { at: i * 40, raw: j.raw ?? 160, score: armScore },
        scores: { shoulder: j.shoulder, elbow: j.elbow, wrist: j.wrist },
        outside: { shoulder: 0, elbow: 0, wrist: i < outsideFrames ? 1 : 0 },
      };
      return { at: i * 40, left: arm, right: arm, shoulderRatio: 0.9, armLenPx: 60 };
    });
    return summarizeCapture(probes, 0);
  }

  it('★手首だけ信頼度が低い場合、手首の行だけが原因として立つ', () => {
    const bottom = captureWithJoints({ shoulder: 0.85, elbow: 0.7, wrist: 0.18, raw: 165 });
    const top = captureWithJoints({ shoulder: 0.84, elbow: 0.68, wrist: 0.2, raw: 45 });
    const r = resolveCalibration('elbow-angle', bottom, top, 0);

    expect(r).toMatchObject({ ok: false, reason: 'low_confidence' });
    const rows = r.diagnostics.joints.filter((x) => x.side === 'right');
    expect(rows.map((x) => x.joint)).toEqual(['shoulder', 'elbow', 'wrist']);
    expect(rows.find((x) => x.joint === 'shoulder')!.isBottleneck).toBe(false);
    expect(rows.find((x) => x.joint === 'elbow')!.isBottleneck).toBe(false);
    // 手首だけが閾値未満 = ここを直せばよいと分かる
    expect(rows.find((x) => x.joint === 'wrist')!.isBottleneck).toBe(true);
    expect(rows.find((x) => x.joint === 'wrist')!.bottomScoreP10).toBeCloseTo(0.18);
    expect(rows.find((x) => x.joint === 'wrist')!.topScoreP10).toBeCloseTo(0.2);
  });

  it('★肩が原因の場合は肩の行が立つ（対処が変わるので区別が必要）', () => {
    const bottom = captureWithJoints({ shoulder: 0.2, elbow: 0.8, wrist: 0.75, raw: 165 });
    const top = captureWithJoints({ shoulder: 0.22, elbow: 0.8, wrist: 0.72, raw: 45 });
    const r = resolveCalibration('elbow-angle', bottom, top, 0);
    const rows = r.diagnostics.joints.filter((x) => x.side === 'left');
    expect(rows.find((x) => x.joint === 'shoulder')!.isBottleneck).toBe(true);
    expect(rows.find((x) => x.joint === 'wrist')!.isBottleneck).toBe(false);
  });

  it('★「腕を下ろすと手首が画面外」を割合で示す', () => {
    // 下端（腕を下ろした状態）でだけ手首が画面外に出ているケース。
    const bottom = captureWithJoints({ shoulder: 0.8, elbow: 0.8, wrist: 0.3, wristOutsideRatio: 0.5, raw: 165 });
    const top = captureWithJoints({ shoulder: 0.8, elbow: 0.8, wrist: 0.8, raw: 45 });
    const r = resolveCalibration('elbow-angle', bottom, top, 0);
    const wrist = r.diagnostics.joints.find((x) => x.side === 'right' && x.joint === 'wrist')!;
    expect(wrist.outsideRatio).toBeCloseTo(0.5);
    expect(wrist.bottomScoreP10).toBeCloseTo(0.3); // 下端だけ低い
    expect(wrist.topScoreP10).toBeCloseTo(0.8);
  });

  it('全関節が十分なら原因行は立たず、キャリブレーションも通る', () => {
    const bottom = captureWithJoints({ shoulder: 0.8, elbow: 0.75, wrist: 0.6, raw: 165 });
    const top = captureWithJoints({ shoulder: 0.8, elbow: 0.75, wrist: 0.6, raw: 45 });
    const r = resolveCalibration('elbow-angle', bottom, top, 0);
    expect(r.ok).toBe(true);
    expect(r.diagnostics.joints.every((x) => !x.isBottleneck)).toBe(true);
  });

  it('診断は常に左右×3関節の6行を返す（失敗理由に関わらず）', () => {
    const flat = captureWithJoints({ shoulder: 0.8, elbow: 0.8, wrist: 0.8, raw: 100 });
    const r = resolveCalibration('elbow-angle', flat, flat, 0); // ROM 0 → 失敗
    expect(r.diagnostics.joints).toHaveLength(6);
    expect(r.diagnostics.minScore).toBeCloseTo(0.35);
  });
});
