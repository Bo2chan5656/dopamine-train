import { beforeEach, describe, expect, it } from 'vitest';
import { createLedger } from '../src/core/credit/ledger';
import { clampPolicy, perSlidePreset, type CreditPolicy } from '../src/core/credit/policy';
import { Emitter } from '../src/core/emitter';
import { SessionController, type HudPort, type SoundPort } from '../src/core/session/controller';
import type { RepEvent } from '../src/core/types';
import type { RepSource, RepSourceEvents } from '../src/sensors/rep-source';
import type { Slider, SliderEvents } from '../src/slider/slider';

/**
 * grant: 'per-slide'（1レップ1スライド）の分岐と、maxTickDtMs の検証。
 *
 * どちらも Chrome 拡張（YouTube Shorts）のために controller.ts に足した振る舞い
 * だが、core/ にあるので DOM もカメラも chrome.* も無しでテストできる。
 */

function validRep(id: number): RepEvent {
  return {
    id,
    at: id * 1000,
    concentricMs: 700,
    eccentricMs: 900,
    romRatio: 1,
    peak: 1,
    minScore: 1,
    side: 'right',
    valid: true,
    rejects: [],
  };
}

function invalidRep(id: number): RepEvent {
  return { ...validRep(id), valid: false, rejects: ['too_fast'] };
}

function fakeSource(): RepSource & { emitRep(rep: RepEvent): void } {
  const events = new Emitter<RepSourceEvents>();
  return {
    kind: 'keyboard',
    caps: { calibration: false, progress: false, preview: false },
    events,
    async init() {},
    start() {},
    stop() {},
    async dispose() {},
    emitRep(rep) {
      events.emit('rep', rep);
    },
  };
}

interface FakeSlider extends Slider {
  readonly nextCalls: string[];
  playing: boolean;
}

function fakeSlider(): FakeSlider {
  const nextCalls: string[] = [];
  let playing = false;
  return {
    kind: 'shorts-extension',
    events: new Emitter<SliderEvents>(),
    nextCalls,
    get playing() {
      return playing;
    },
    set playing(v: boolean) {
      playing = v;
    },
    async attach() {},
    async detach() {},
    async play() {
      playing = true;
    },
    async pause() {
      playing = false;
    },
    setLocked() {},
    async next(reason) {
      nextCalls.push(reason);
    },
    isPlaying() {
      return playing;
    },
  };
}

const noopHud: HudPort = { update: () => undefined };
const noopSound: SoundPort = {
  rep: () => undefined,
  invalid: () => undefined,
  low: () => undefined,
  depleted: () => undefined,
};

function build(policy: CreditPolicy, maxTickDtMs?: number) {
  const source = fakeSource();
  const slider = fakeSlider();
  const ledger = createLedger(policy, null);
  const controller = new SessionController({
    source,
    ledger,
    slider,
    hud: noopHud,
    sound: noopSound,
    settings: { credit: policy },
    clock: { wall: () => 1_000_000 },
    ...(maxTickDtMs === undefined ? {} : { maxTickDtMs }),
  });
  controller.start();
  return { source, slider, ledger, controller };
}

describe("grant: 'per-slide'", () => {
  it('N=1 なら1レップごとに1スライド送る', () => {
    const { source, slider } = build(perSlidePreset());
    source.emitRep(validRep(1));
    expect(slider.nextCalls).toEqual(['reward']);
    source.emitRep(validRep(2));
    source.emitRep(validRep(3));
    expect(slider.nextCalls).toEqual(['reward', 'reward', 'reward']);
  });

  it('無効レップでは送らない（付与そのものが起きないため）', () => {
    const { source, slider } = build(perSlidePreset());
    source.emitRep(invalidRep(1));
    expect(slider.nextCalls).toEqual([]);
  });

  it('N=3 なら3レップ目でだけ送る（per-slide でも N は効く）', () => {
    const { source, slider } = build(clampPolicy({ grant: 'per-slide', repsPerGrant: 3, secondsPerGrant: 30 }));
    source.emitRep(validRep(1));
    source.emitRep(validRep(2));
    expect(slider.nextCalls).toEqual([]);
    source.emitRep(validRep(3));
    expect(slider.nextCalls).toEqual(['reward']);
  });

  it('貯蓄上限に達して実質0秒しか付与されなくても、granted は出るので送られる', () => {
    // maxBankedSeconds = 60、X = 30 なので3レップ目の付与は 0 秒になる。
    // それでも「レップをこなした」事実に対する送りは起きる（体験上、無反応が最悪）。
    const { source, slider } = build(perSlidePreset(30));
    source.emitRep(validRep(1));
    source.emitRep(validRep(2));
    source.emitRep(validRep(3));
    expect(slider.nextCalls).toHaveLength(3);
  });
});

describe("grant: 'bank'", () => {
  it('★付与されてもスライドは送らない（報酬は「再生できる時間」であってスライドではない）', () => {
    const { source, slider } = build(clampPolicy({ grant: 'bank', repsPerGrant: 1, secondsPerGrant: 60 }));
    source.emitRep(validRep(1));
    source.emitRep(validRep(2));
    expect(slider.nextCalls).toEqual([]);
  });
});

describe('maxTickDtMs', () => {
  let policy: CreditPolicy;
  beforeEach(() => {
    policy = clampPolicy({ grant: 'bank', repsPerGrant: 1, secondsPerGrant: 100, maxBankedSeconds: 100 });
  });

  it('既定（1000ms）では dt=1500 のフレームを消費に使わない', () => {
    const { source, slider, ledger, controller } = build(policy);
    source.emitRep(validRep(1)); // 100秒付与
    slider.playing = true;
    controller.tick(0, true); // 初回は dt=0
    controller.tick(1500, true);
    expect(ledger.balanceSeconds).toBe(100);
  });

  it('★2000 を渡すと dt=1500 でも消費する（拡張のトレーナーは絞られて1秒間隔になる）', () => {
    const { source, slider, ledger, controller } = build(policy, 2000);
    source.emitRep(validRep(1));
    slider.playing = true;
    controller.tick(0, true);
    controller.tick(1500, true);
    expect(ledger.balanceSeconds).toBeCloseTo(98.5, 5);
  });

  it('2000 を渡しても、それを超える巨大ギャップは捨てる（復帰時の一気消費を防ぐ）', () => {
    const { source, slider, ledger, controller } = build(policy, 2000);
    source.emitRep(validRep(1));
    slider.playing = true;
    controller.tick(0, true);
    controller.tick(60_000, true);
    expect(ledger.balanceSeconds).toBe(100);
  });

  it('再生していなければ消費しない（Shorts 側が一時停止中のケース）', () => {
    const { source, slider, ledger, controller } = build(policy, 2000);
    source.emitRep(validRep(1));
    slider.playing = false;
    controller.tick(0, true);
    controller.tick(500, true);
    expect(ledger.balanceSeconds).toBe(100);
  });
});

describe('perSlidePreset', () => {
  it('貯め込みを X の2本分に絞る（既定の600秒だと20本先まで貯まってしまう）', () => {
    const p = perSlidePreset(30);
    expect(p.grant).toBe('per-slide');
    expect(p.repsPerGrant).toBe(1);
    expect(p.secondsPerGrant).toBe(30);
    expect(p.maxBankedSeconds).toBe(60);
  });

  it('clampPolicy は grant を素通しする（bank 固定だった実装の名残がないこと）', () => {
    expect(clampPolicy({ grant: 'per-slide' }).grant).toBe('per-slide');
    expect(clampPolicy({}).grant).toBe('bank');
  });
});
