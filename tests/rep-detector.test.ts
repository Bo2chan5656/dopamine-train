import { describe, expect, it } from 'vitest';
import { denormalize, type Calibration } from '../src/core/detect/calibration';
import { createRepDetector, DEFAULT_DETECTOR_CONFIG, type DetectorConfig, type DetectorOutput } from '../src/core/detect/rep-detector';
import type { RepEvent, SignalSample, TrackingState } from '../src/core/types';
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

describe('RepDetector: 沈黙診断', () => {
  it('上端が0.75までしか届かない×20 → valid 0 かつ top_unreachable が発火する', () => {
    const samples = sineWave(CAL, { fps: 24, cycles: 20, cycleMs: 1500, ampCenter: 0.375, ampRadius: 0.375 });
    const out = runAll(CFG, CAL, samples);
    expect(reps(out)).toHaveLength(0);
    const diags = diagnostics(out);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0]!.hint).toBe('top_unreachable');
    expect(diags[0]!.observedMax).toBeGreaterThan(0.35);
    expect(diags[0]!.observedMax).toBeLessThan(CFG.topThreshold);
  });

  it('★上端は超えるが谷が0.4止まりで下端に戻らない → valid 0 かつ bottom_unreachable が発火する', () => {
    // 実機の信号グラフで踏んだケース。シュミットトリガは「下端に入ってから上端を
    // 超える」ことでレップを数えるので、下端(0.2)に戻らなければ永久に0本のまま。
    // 旧実装の診断条件は sessionMax < topThreshold だったため、この状況では
    // 何の警告も出ないという一番まずい沈黙が起きていた。
    // ampRadius は One-Euro の減衰を見込んで広く取る（狭いとフィルタ後のピークが
    // 0.8 に届かず top_unreachable 側になってしまう）。生値は [0.4, 1.2]。
    const samples = sineWave(CAL, { fps: 24, cycles: 20, cycleMs: 1500, ampCenter: 0.8, ampRadius: 0.4 });
    const out = runAll(CFG, CAL, samples);
    expect(reps(out)).toHaveLength(0);
    const diags = diagnostics(out);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0]!.hint).toBe('bottom_unreachable');
    expect(diags[0]!.observedMax).toBeGreaterThanOrEqual(CFG.topThreshold);
    expect(diags[0]!.observedMin).toBeGreaterThan(CFG.bottomThreshold);
  });

  it('正常にレップが出ている間は診断が出ない（誤警告しない）', () => {
    const samples = sineWave(CAL, { fps: 24, cycles: 20, cycleMs: 1500 });
    const out = runAll(CFG, CAL, samples);
    expect(reps(out).length).toBeGreaterThan(15);
    expect(diagnostics(out)).toHaveLength(0);
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
  it('reset 後は phase/lost/sessionMax/sessionMin が初期状態に戻る', () => {
    const detector = createRepDetector(CFG, CAL, 'right');
    for (const s of sineWave(CAL, { fps: 24, cycles: 2, cycleMs: 1500 })) detector.update(s);
    expect(detector.snapshot().sessionMax).toBeGreaterThan(0); // 稼働した形跡がある

    detector.reset();
    expect(detector.snapshot()).toEqual({ phase: 'unknown', lost: false, sessionMax: 0, sessionMin: 1 });
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

describe('RepDetector: 下端での休憩', () => {
  /** norm 列を fps のサンプル列にする（休憩を含む長い列を組み立てるため） */
  function fromNorms(norms: readonly number[], fps = 22): SignalSample[] {
    const dt = 1000 / fps;
    return norms.map((n, i) => ({ at: i * dt, raw: denormalize(n, CAL), score: 0.9 }));
  }
  const hold = (n: number, ms: number, fps = 22): number[] =>
    Array.from({ length: Math.round((ms / 1000) * fps) }, () => n);
  const ramp = (from: number, to: number, ms: number, fps = 22): number[] => {
    const k = Math.max(2, Math.round((ms / 1000) * fps));
    return Array.from({ length: k }, (_, i) => from + ((to - from) * i) / (k - 1));
  };
  /** 下端で restMs 休んでから2本目を挙げる、という列 */
  const twoRepsWithRest = (restMs: number): number[] => [
    ...hold(0, 800),
    ...ramp(0, 1, 600),
    ...hold(1, 600),
    ...ramp(1, 0, 800),
    ...hold(0, restMs),
    ...ramp(0, 1, 600),
    ...hold(1, 300),
  ];

  it('★下端で30秒休んでも2本目が valid（concentricMs に休憩時間を含めない）', () => {
    // per-slide 方式では1レップごとに動画を30秒見る＝下端で30秒休む。
    // concentricMs が「下端ゾーンに入ってからの経過時間」だった頃は
    // concentricMs=30636 → too_slow で2本目以降が全部無効になっていた
    // （＝最初の1回だけ動いて、あとは何をしても解放されない）。
    const r = reps(runAll(CFG, CAL, fromNorms(twoRepsWithRest(30_000))));
    expect(r).toHaveLength(2);
    expect(r[1]!.valid).toBe(true);
    expect(r[1]!.rejects).toEqual([]);
    // 実際の挙上時間（約600msのランプ + フィルタ遅れ）に収まっていること
    expect(r[1]!.concentricMs).toBeLessThan(CFG.maxConcentricMs);
    expect(r[1]!.concentricMs).toBeGreaterThanOrEqual(CFG.minConcentricMs);
  });

  it('休憩が短い場合も従来どおり valid', () => {
    const r = reps(runAll(CFG, CAL, fromNorms(twoRepsWithRest(1000))));
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.valid)).toBe(true);
  });

  it('休憩の長さによらず concentricMs がほぼ一定になる（休憩時間が混ざらない証明）', () => {
    const short = reps(runAll(CFG, CAL, fromNorms(twoRepsWithRest(1000))))[1]!.concentricMs;
    const long = reps(runAll(CFG, CAL, fromNorms(twoRepsWithRest(30_000))))[1]!.concentricMs;
    expect(Math.abs(long - short)).toBeLessThan(150);
  });

  it('挙上そのものが遅い場合は依然として too_slow で弾く（緩めすぎていない）', () => {
    // 0.2→0.8 の区間（ランプ全体の60%）が maxConcentricMs(4000) を超えるよう
    // 12秒かけて上げる → 4000 < 12000*0.6 = 7200ms なので too_slow。
    const r = reps(runAll(CFG, CAL, fromNorms([...hold(0, 800), ...ramp(0, 1, 12_000), ...hold(1, 300)])));
    expect(r).toHaveLength(1);
    expect(r[0]!.valid).toBe(false);
    expect(r[0]!.rejects).toContain('too_slow');
  });
});

describe('RepDetector: 運動中の low_confidence（体がよく見えていません）', () => {
  function fromNorms(norms: readonly number[], score: number | ((i: number) => number), fps = 22): SignalSample[] {
    const dt = 1000 / fps;
    return norms.map((n, i) => ({
      at: i * dt,
      raw: denormalize(n, CAL),
      score: typeof score === 'function' ? score(i) : score,
    }));
  }
  const hold = (n: number, ms: number, fps = 22): number[] =>
    Array.from({ length: Math.round((ms / 1000) * fps) }, () => n);
  const ramp = (from: number, to: number, ms: number, fps = 22): number[] => {
    const k = Math.max(2, Math.round((ms / 1000) * fps));
    return Array.from({ length: k }, (_, i) => from + ((to - from) * i) / (k - 1));
  };

  it('信頼度が一貫して warnScore 以上なら valid', () => {
    const norms = [...hold(0, 500), ...ramp(0, 1, 700), ...hold(1, 300)];
    const r = reps(runAll(CFG, CAL, fromNorms(norms, 0.6)));
    expect(r).toHaveLength(1);
    expect(r[0]!.valid).toBe(true);
  });

  it('挙上中に warnScore を割るフレームがあれば low_confidence', () => {
    const norms = [...hold(0, 500), ...ramp(0, 1, 700), ...hold(1, 300)];
    // 挙上の途中（下端を出たあと）で1フレームだけ落とす
    const dipAt = Math.round((0.5 + 0.35) * 22);
    const r = reps(runAll(CFG, CAL, fromNorms(norms, (i) => (i === dipAt ? 0.31 : 0.6))));
    expect(r).toHaveLength(1);
    expect(r[0]!.rejects).toContain('low_confidence');
    expect(r[0]!.minScore).toBeCloseTo(0.31);
  });

  it('★下端で休んでいる間に信頼度が落ちても、次のレップは無効にならない', () => {
    // これが「実際に挙げてもカウントされない」の主因だったバグ。
    // repMinScore が enterBottom からの最小値だったため、下端の休憩30秒のうち
    // 1フレーム落ちるだけで次のレップが low_confidence になっていた。
    // per-slide 方式では1レップごとに動画を30秒見る＝下端で30秒休むので致命的。
    const fps = 22;
    const norms = [
      ...hold(0, 500, fps),
      ...ramp(0, 1, 700, fps),
      ...hold(1, 400, fps),
      ...ramp(1, 0, 800, fps),
      ...hold(0, 10_000, fps), // 下端で10秒休む
      ...ramp(0, 1, 700, fps),
      ...hold(1, 300, fps),
    ];
    // 休憩区間のちょうど中央で大きく信頼度を落とす（腕を組んだ・体をひねった等）
    const restStart = Math.round((0.5 + 0.7 + 0.4 + 0.8) * fps);
    const dipAt = restStart + Math.round(5 * fps);
    const r = reps(runAll(CFG, CAL, fromNorms(norms, (i) => (i === dipAt ? 0.31 : 0.6))));

    expect(r).toHaveLength(2);
    expect(r[1]!.valid).toBe(true);
    expect(r[1]!.rejects).toEqual([]);
    // 2本目の minScore は挙上中の値のみを反映している
    expect(r[1]!.minScore).toBeCloseTo(0.6);
  });

  it('warnScore の既定値がキャリブレーションの受理ゲート(0.35)と一致している', () => {
    // 入口(キャリブレーション)より出口(運動中)が厳しいと
    // 「キャリブレーションは通るのに全レップ弾かれる」になる。
    expect(DEFAULT_DETECTOR_CONFIG.warnScore).toBeCloseTo(0.35);
    // フレーム破棄の閾値は warnScore 以下であること（破棄されない値が即無効に
    // なる帯が広がりすぎないように）。
    expect(DEFAULT_DETECTOR_CONFIG.minScore).toBeLessThanOrEqual(DEFAULT_DETECTOR_CONFIG.warnScore);
  });
});
