import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/core/filter/one-euro';

describe('OneEuroFilter', () => {
  it('ステップ入力に対して単調に収束する', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 1, dCutoff: 1 });
    f.filter(0, 0);
    let prev = 0;
    for (let i = 1; i <= 30; i++) {
      const v = f.filter(1, i * (1 / 30));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9); // 単調非減少
      prev = v;
    }
    expect(prev).toBeGreaterThan(0.9); // 十分収束している
    expect(prev).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('dt が 0（同一タイムスタンプ連続）でも NaN/Inf を出さない', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 1, dCutoff: 1 });
    f.filter(0, 1.0);
    const v = f.filter(0.5, 1.0); // 同じ t を渡す
    expect(Number.isFinite(v)).toBe(true);
  });

  it('dt が巨大（10秒の欠測明け）でも NaN/Inf を出さない', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 1, dCutoff: 1 });
    f.filter(0, 0);
    const v = f.filter(1, 10);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('dt が細かくジッタしても出力は有限のまま', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 1, dCutoff: 1 });
    let t = 0;
    let x = 0;
    for (let i = 0; i < 100; i++) {
      t += 1 / 30 + (i % 3 === 0 ? 0.02 : -0.005); // フレーム間隔がガタつく
      x = Math.sin(i * 0.3);
      const v = f.filter(x, t);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('reset() 後は初回サンプルをそのまま通す（内部状態が残らない）', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 1, dCutoff: 1 });
    f.filter(0, 0);
    f.filter(1, 1);
    f.filter(1, 2);
    f.reset();
    const v = f.filter(0.42, 100); // reset 後の最初の呼び出しは常に x をそのまま返す
    expect(v).toBe(0.42);
  });

  it('beta を上げるとステップ応答の立ち上がりが速くなる', () => {
    const lowBeta = new OneEuroFilter({ minCutoff: 1, beta: 0.1, dCutoff: 1 });
    const highBeta = new OneEuroFilter({ minCutoff: 1, beta: 5, dCutoff: 1 });
    lowBeta.filter(0, 0);
    highBeta.filter(0, 0);

    const dt = 1 / 30;
    let lowV = 0;
    let highV = 0;
    for (let i = 1; i <= 5; i++) {
      lowV = lowBeta.filter(1, i * dt);
      highV = highBeta.filter(1, i * dt);
    }
    // 同じ経過時間・同じステップ入力で、beta が大きい方が目標値により近づいている
    expect(highV).toBeGreaterThan(lowV);
  });

  it('定常状態のノイズはある程度平滑化される（生値の分散より出力の分散が小さい）', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.3, dCutoff: 1 });
    const raw: number[] = [];
    const filtered: number[] = [];
    let t = 0;
    // 決定論的な疑似ノイズ（sin の合成）を center=0.5 に加える
    for (let i = 0; i < 60; i++) {
      t += 1 / 30;
      const noise = 0.05 * Math.sin(i * 12.9) + 0.03 * Math.sin(i * 31.7);
      const x = 0.5 + noise;
      raw.push(x);
      filtered.push(f.filter(x, t));
    }
    expect(variance(filtered)).toBeLessThan(variance(raw));
  });
});

function variance(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}
