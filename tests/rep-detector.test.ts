import { describe, expect, it } from 'vitest';
import type { Calibration } from '../src/core/detect/calibration';
import { createRepDetector, DEFAULT_DETECTOR_CONFIG, type DetectorConfig, type DetectorOutput } from '../src/core/detect/rep-detector';
import type { RepEvent, TrackingState } from '../src/core/types';
import {
  asymmetricReps,
  halfReps,
  jitterNear,
  sineWave,
  stallDuringRise,
  withLowScoreWindow,
} from './signal-generator';

const CAL: Calibration = {
  signal: 'elbow-angle',
  side: 'right',
  view: 'side45',
  bottomRaw: 160,
  topRaw: 40,
  armLenPx: 200,
  createdAt: 0,
};

const CFG: DetectorConfig = DEFAULT_DETECTOR_CONFIG;

function runAll(cfg: DetectorConfig, cal: Calibration, samples: ReturnType<typeof sineWave>): DetectorOutput[] {
  const detector = createRepDetector(cfg, cal, cal.side);
  const out: DetectorOutput[] = [];
  for (const s of samples) out.push(...detector.update(s));
  return out;
}

function reps(outputs: readonly DetectorOutput[]): RepEvent[] {
  return outputs.filter((o): o is Extract<DetectorOutput, { type: 'rep' }> => o.type === 'rep').map((o) => o.rep);
}
function trackings(outputs: readonly DetectorOutput[]): TrackingState[] {
  return outputs
    .filter((o): o is Extract<DetectorOutput, { type: 'tracking' }> => o.type === 'tracking')
    .map((o) => o.state);
}
function diagnostics(outputs: readonly DetectorOutput[]) {
  return outputs.filter((o): o is Extract<DetectorOutput, { type: 'diagnostic' }> => o.type === 'diagnostic');
}

describe('RepDetector: きれいな信号', () => {
  it('正弦10周期、24fpsで valid 10', () => {
    const samples = sineWave(CAL, { fps: 24, cycles: 10, cycleMs: 1500 });
    const out = runAll(CFG, CAL, samples);
    const r = reps(out);
    expect(r).toHaveLength(10);
    expect(r.every((x) => x.valid)).toBe(true);
  });

  it('ガウスノイズ σ=0.03 を乗せても valid 10（One-Euro Filter が効いている証拠）', () => {
    const samples = sineWave(CAL, { fps: 24, cycles: 10, cycleMs: 1500, noiseSigma: 0.03, seed: 7 });
    const out = runAll(CFG, CAL, samples);
    const r = reps(out);
    expect(r).toHaveLength(10);
    expect(r.every((x) => x.valid)).toBe(true);
  });

  it('15fps/24fps/30fpsで同一のレップ数になる（fps非依存性）', () => {
    const counts = [15, 24, 30].map((fps) => {
      const samples = sineWave(CAL, { fps, cycles: 10, cycleMs: 1500 });
      return reps(runAll(CFG, CAL, samples)).length;
    });
    expect(counts).toEqual([10, 10, 10]);
  });
});

describe('RepDetector: フルレップに達しない動き', () => {
  it('閾値近傍(0.8付近)で高周波振動しても valid 0・chatter も 0（そもそも遷移しない）', () => {
    const samples = jitterNear(CAL, { center: 0.8, amplitude: 0.02, hz: 8, durationMs: 5000, fps: 24 });
    const out = runAll(CFG, CAL, samples);
    expect(reps(out)).toHaveLength(0);
  });

  it('ハーフレップ（top閾値0.8に届かず0.6止まり）×5で valid 0', () => {
    const samples = halfReps(CAL, { count: 5, peakNorm: 0.6, halfCycleMs: 750, fps: 24 });
    const out = runAll(CFG, CAL, samples);
    expect(reps(out)).toHaveLength(0);
  });
});

describe('RepDetector: 妥当性検査（validity）', () => {
  it('0.2秒で往復×5 → 全て invalid・too_fast を含む', () => {
    // 高速な往復を正しく捉えるため fps を上げる（24fpsでは間引かれ過ぎて閾値を正しく検出できない）
    const samples = asymmetricReps(CAL, { count: 5, concentricMs: 100, eccentricMs: 100, fps: 90 });
    const out = runAll(CFG, CAL, samples);
    const r = reps(out);
    expect(r).toHaveLength(5);
    for (const rep of r) {
      expect(rep.valid).toBe(false);
      expect(rep.rejects).toContain('too_fast');
    }
  });

  it('上昇1.5秒・下降が速すぎる×5 → エキセントリックが速すぎるレップは fast_eccentric になる', () => {
    // 1本目は「前回の上端」が無く eccentricMs=null なので fast_eccentric の評価対象外
    // （設計上正しい: types.ts の RepEvent.eccentricMs の定義を参照）。ウォームアップを
    // 1回追加し、検証対象の5本すべてに直前の上端が存在するようにする。
    //
    // 生成器の下降時間は 50ms に設定しているが、One-Euro Filter の群遅延により
    // 実測 eccentricMs は約458ms（生値ではなく、フィルタ後の値で閾値通過を判定する
    // 設計のため）。450ms 台であれば minEccentricMs(500ms) を安定して下回る。
    const samples = asymmetricReps(CAL, { count: 6, concentricMs: 1500, eccentricMs: 50, fps: 24 });
    const out = runAll(CFG, CAL, samples);
    const r = reps(out);
    expect(r).toHaveLength(6);
    const [warmup, ...target] = r;
    expect(warmup!.eccentricMs).toBeNull();
    expect(target).toHaveLength(5);
    for (const rep of target) {
      expect(rep.valid).toBe(false);
      expect(rep.rejects).toContain('fast_eccentric');
      expect(rep.eccentricMs).not.toBeNull();
      expect(rep.eccentricMs!).toBeLessThan(CFG.minEccentricMs);
    }
  });

  it('上昇中に閾値超えの時間だけ静止 → too_slow で無効になり、二重計上しない', () => {
    // hold(4200ms) だけで maxConcentricMs(4000ms) を超えるようにする。riseMs は
    // One-Euro Filter が最終的に topThreshold(0.8) まで追従しきれる長さが必要
    // （riseMs=100 だとフィルタの群遅延で filtered 値が 0.76 止まりになり閾値に届かない）。
    const samples = stallDuringRise(CAL, { midNorm: 0.5, riseMs: 300, holdMs: 4200, fps: 24 });
    const out = runAll(CFG, CAL, samples);
    const r = reps(out);
    expect(r).toHaveLength(1); // 二重計上されない
    expect(r[0]!.valid).toBe(false);
    expect(r[0]!.rejects).toContain('too_slow');
  });
});

describe('RepDetector: 上端に届かない（threshold_unreachable 診断）', () => {
  it('上端が0.75までしか届かない×20 → valid 0 かつ threshold_unreachable が発火する', () => {
    const samples = sineWave(CAL, { fps: 24, cycles: 20, cycleMs: 1500, ampCenter: 0.375, ampRadius: 0.375 });
    const out = runAll(CFG, CAL, samples);
    expect(reps(out)).toHaveLength(0);
    const diags = diagnostics(out);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0]!.hint).toBe('threshold_unreachable');
    expect(diags[0]!.observedMax).toBeGreaterThan(0.35);
    expect(diags[0]!.observedMax).toBeLessThan(CFG.topThreshold);
  });
});

describe('RepDetector: トラッキングロスト', () => {
  it('途中の1.5秒の低score区間を跨いだレップは計上されず、lost→okが各1回発火する', () => {
    const clean = sineWave(CAL, { fps: 24, cycles: 5, cycleMs: 1500 });
    // 1本目の rep 完了(約528ms)を含む区間を低スコアにする(lostAfterMs=700 を超える1.5秒)
    const samples = withLowScoreWindow(clean, { fromMs: 100, toMs: 1600, score: 0.1 });
    const out = runAll(CFG, CAL, samples);

    const r = reps(out);
    expect(r).toHaveLength(4); // 5本中、低スコア区間に跨いだ1本目だけ計上されない
    expect(r.every((x) => x.valid)).toBe(true);

    const tr = trackings(out);
    expect(tr.filter((s) => s.kind === 'lost')).toHaveLength(1);
    expect(tr.filter((s) => s.kind === 'ok').length).toBeGreaterThanOrEqual(1);
  });

  it('低スコアが lostAfterMs 未満で回復した場合は lost にならず ok だけ発火する', () => {
    const clean = sineWave(CAL, { fps: 24, cycles: 3, cycleMs: 1500 });
    // 200ms だけの短い落ち込み（lostAfterMs=700 未満）
    const samples = withLowScoreWindow(clean, { fromMs: 2000, toMs: 2200, score: 0.1 });
    const out = runAll(CFG, CAL, samples);

    const tr = trackings(out);
    expect(tr.filter((s) => s.kind === 'lost')).toHaveLength(0);
    expect(tr.filter((s) => s.kind === 'ok').length).toBeGreaterThanOrEqual(1);
    // レップ自体は普通に3本カウントされる（一瞬のブレは無視される）
    expect(reps(out)).toHaveLength(3);
  });

  it('復帰直後は端に到達するまで数え始めない（phaseがunknownにリセットされる）', () => {
    const detector = createRepDetector(CFG, CAL, 'right');
    // 一瞬で lost にする: 低スコアを lostAfterMs 以上続ける
    let out: DetectorOutput[] = [];
    out = out.concat(detector.update({ at: 0, raw: 100, score: 0.01 }));
    out = out.concat(detector.update({ at: 800, raw: 100, score: 0.01 })); // lostAfterMs(700)超過 → lost
    expect(trackings(out).some((s) => s.kind === 'lost')).toBe(true);

    // 復帰直後、いきなり中間値（0.5相当）で来ても、それだけではレップにならない
    const midRaw = CAL.bottomRaw + 0.5 * (CAL.topRaw - CAL.bottomRaw);
    out = out.concat(detector.update({ at: 850, raw: midRaw, score: 0.9 }));
    expect(reps(out)).toHaveLength(0);
    expect(detector.snapshot().phase).toBe('unknown');
  });
});

describe('RepDetector: 信頼度ゲート', () => {
  it('score が minScore 未満のフレームは progress も emit しない（フィルタに入れない）', () => {
    const detector = createRepDetector(CFG, CAL, 'right');
    const out = detector.update({ at: 0, raw: CAL.bottomRaw, score: 0.05 }); // minScore(0.3)未満
    expect(out.filter((o) => o.type === 'progress')).toHaveLength(0);
  });
});

describe('RepDetector: reset()', () => {
  it('reset 後は phase/lost/sessionMax が初期状態に戻る', () => {
    const detector = createRepDetector(CFG, CAL, 'right');
    for (const s of sineWave(CAL, { fps: 24, cycles: 2, cycleMs: 1500 })) detector.update(s);
    expect(detector.snapshot().sessionMax).toBeGreaterThan(0); // 稼働した形跡がある

    detector.reset();
    expect(detector.snapshot()).toEqual({ phase: 'unknown', lost: false, sessionMax: 0 });
  });

  it('reset 後、新しいレップ計上が0件から正しく再開する', () => {
    const detector = createRepDetector(CFG, CAL, 'right');
    for (const s of sineWave(CAL, { fps: 24, cycles: 3, cycleMs: 1500 })) detector.update(s);
    detector.reset();

    let out: DetectorOutput[] = [];
    for (const s of sineWave(CAL, { fps: 24, cycles: 4, cycleMs: 1500 })) out = out.concat(detector.update(s));
    expect(reps(out)).toHaveLength(4);
  });
});
