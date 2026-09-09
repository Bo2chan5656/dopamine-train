import { describe, expect, it } from 'vitest';
import {
  denormalize,
  normalize,
  summarize,
  validateCalibration,
  type Calibration,
  type CalibrationSample,
} from '../src/core/detect/calibration';
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

function goodSummary(frames = 30, minScore = 0.9): CalibrationSample {
  return { p10: 0, p50: 0, p90: 0, minScore, frames };
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

  it('score はサンプル群の最小値を取る', () => {
    const samples = [sample(1, 0.9), sample(1, 0.4), sample(1, 0.95)];
    expect(summarize(samples).minScore).toBeCloseTo(0.4);
  });

  it('空配列は frames:0 を返し例外を投げない', () => {
    const s = summarize([]);
    expect(s.frames).toBe(0);
  });

  it('1件だけでも percentile 計算が破綻しない', () => {
    const s = summarize([sample(42, 0.8)]);
    expect(s.p10).toBe(42);
    expect(s.p50).toBe(42);
    expect(s.p90).toBe(42);
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
    // raw=160+120=280 は正規化で -1.0 相当だが、クランプで -0.5 になる
    expect(normalize(280, cal)).toBeCloseTo(-0.5);
    // raw=40-120=-80 は正規化で 2.0 相当だが、クランプで 1.5 になる
    expect(normalize(-80, cal)).toBeCloseTo(1.5);
  });

  it('denormalize は normalize の逆演算になる', () => {
    const cal = wristCal();
    for (const n of [0, 0.25, 0.5, 0.75, 1]) {
      const raw = denormalize(n, cal);
      expect(normalize(raw, cal)).toBeCloseTo(n, 6);
    }
  });

  it('span が 0（壊れたキャリブレーション）でも例外を投げず 0.5 を返す', () => {
    const cal = elbowCal({ bottomRaw: 100, topRaw: 100 });
    expect(normalize(100, cal)).toBe(0.5);
  });
});

describe('validateCalibration', () => {
  it('正常な elbow-angle キャリブレーションは ok', () => {
    const cal = elbowCal();
    const result = validateCalibration(cal, { bottom: goodSummary(), top: goodSummary() });
    expect(result.ok).toBe(true);
  });

  it('正常な wrist-height キャリブレーションは ok', () => {
    const cal = wristCal();
    const result = validateCalibration(cal, { bottom: goodSummary(), top: goodSummary() });
    expect(result.ok).toBe(true);
  });

  it('ROM が小さすぎる（手首をちょこちょこ振っただけ）と rom_too_small で弾かれる', () => {
    const cal = elbowCal({ bottomRaw: 100, topRaw: 90 }); // 差10° < 60°
    const result = validateCalibration(cal, { bottom: goodSummary(), top: goodSummary() });
    expect(result).toEqual({ ok: false, reason: 'rom_too_small' });
  });

  it('wrist-height の raw は既に上腕長で正規化済みの比率なので、しきい値は固定の0.8（armLenPxを掛け直さない）', () => {
    // |top - bottom| = 0.7 < 0.8 → 不足。armLenPx がいくつであっても結果は変わらない。
    const cal = wristCal({ bottomRaw: -0.5, topRaw: 0.2, armLenPx: 999 });
    const result = validateCalibration(cal, { bottom: goodSummary(), top: goodSummary() });
    expect(result).toEqual({ ok: false, reason: 'rom_too_small' });
  });

  it('bottom/top の向きが逆転していると inverted で弾かれる', () => {
    const cal = elbowCal({ bottomRaw: 40, topRaw: 160 }); // 本来と逆
    const result = validateCalibration(cal, { bottom: goodSummary(), top: goodSummary() });
    expect(result).toEqual({ ok: false, reason: 'inverted' });
  });

  it('wrist-height でも向きの逆転を検出する', () => {
    const cal = wristCal({ bottomRaw: 0.3, topRaw: -1.2 }); // 本来と逆
    const result = validateCalibration(cal, { bottom: goodSummary(), top: goodSummary() });
    expect(result).toEqual({ ok: false, reason: 'inverted' });
  });

  it('記録中の信頼度が低いと low_confidence で弾かれる', () => {
    const cal = elbowCal();
    const result = validateCalibration(cal, {
      bottom: goodSummary(30, 0.2),
      top: goodSummary(),
    });
    expect(result).toEqual({ ok: false, reason: 'low_confidence' });
  });

  it('記録フレーム数が少なすぎると low_confidence で弾かれる', () => {
    const cal = elbowCal();
    const result = validateCalibration(cal, {
      bottom: goodSummary(1),
      top: goodSummary(),
    });
    expect(result).toEqual({ ok: false, reason: 'low_confidence' });
  });
});
