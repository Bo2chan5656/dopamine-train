import { describe, expect, it } from 'vitest';
import { transition, type SessionEvent, type SessionState } from '../src/core/session/session-machine';

const ALL_STATES: readonly SessionState[] = [
  'boot',
  'needs-permission',
  'calibrating',
  'earning',
  'watching',
  'depleted',
  'tracking-lost',
  'cooldown',
  'daily-capped',
];

// 各イベント型の代表値を1つずつ。event.t で分岐が完結する設計なので、
// 事実上「どの状態でも安全に評価できるか」を確認する総当たりに使う。
const REPRESENTATIVE_EVENTS: readonly SessionEvent[] = [
  { t: 'sensor-ready', needsCalibration: false },
  { t: 'sensor-ready', needsCalibration: true },
  { t: 'permission-denied' },
  { t: 'calibrated' },
  { t: 'credit-granted' },
  { t: 'credit-depleted' },
  { t: 'user-watch' },
  { t: 'user-earn' },
  { t: 'tracking', state: { kind: 'ok', minScore: 1 } },
  { t: 'tracking', state: { kind: 'lost', sinceMs: 0 } },
  { t: 'tracking', state: { kind: 'low-confidence', minScore: 0.1 } },
  { t: 'tracking', state: { kind: 'no-sensor', reason: 'test' } },
  { t: 'daily-cap-reached' },
  { t: 'daily-cap-cleared' },
  { t: 'cooldown-start' },
  { t: 'cooldown-end' },
];

describe('session-machine transition (全網羅)', () => {
  it('全 state × 全 event の組み合わせで例外を投げず、有効な SessionState を返す', () => {
    for (const state of ALL_STATES) {
      for (const event of REPRESENTATIVE_EVENTS) {
        const next = transition(state, event);
        expect(ALL_STATES).toContain(next);
      }
    }
  });

  it('cooldown-start はどの状態からでも即座に cooldown へ割り込む', () => {
    for (const state of ALL_STATES) {
      expect(transition(state, { t: 'cooldown-start' })).toBe('cooldown');
    }
  });

  it('daily-cap-reached はどの状態からでも即座に daily-capped へ割り込む', () => {
    for (const state of ALL_STATES) {
      expect(transition(state, { t: 'daily-cap-reached' })).toBe('daily-capped');
    }
  });

  it('cooldown-end は cooldown からのみ earning に戻し、他は無視する', () => {
    expect(transition('cooldown', { t: 'cooldown-end' })).toBe('earning');
    for (const state of ALL_STATES.filter((s) => s !== 'cooldown')) {
      expect(transition(state, { t: 'cooldown-end' })).toBe(state);
    }
  });

  it('daily-cap-cleared は daily-capped からのみ earning に戻し、他は無視する', () => {
    expect(transition('daily-capped', { t: 'daily-cap-cleared' })).toBe('earning');
    for (const state of ALL_STATES.filter((s) => s !== 'daily-capped')) {
      expect(transition(state, { t: 'daily-cap-cleared' })).toBe(state);
    }
  });

  it('permission-denied はどの状態からでも needs-permission になる', () => {
    for (const state of ALL_STATES) {
      expect(transition(state, { t: 'permission-denied' })).toBe('needs-permission');
    }
  });

  it('sensor-ready: boot/needs-permission から、キャリブ要否で分岐する', () => {
    expect(transition('boot', { t: 'sensor-ready', needsCalibration: false })).toBe('earning');
    expect(transition('boot', { t: 'sensor-ready', needsCalibration: true })).toBe('calibrating');
    expect(transition('needs-permission', { t: 'sensor-ready', needsCalibration: false })).toBe('earning');
    expect(transition('needs-permission', { t: 'sensor-ready', needsCalibration: true })).toBe('calibrating');
  });

  it('sensor-ready: boot/needs-permission 以外では無視する', () => {
    for (const state of ALL_STATES.filter((s) => s !== 'boot' && s !== 'needs-permission')) {
      expect(transition(state, { t: 'sensor-ready', needsCalibration: false })).toBe(state);
    }
  });

  it('calibrated は calibrating からのみ earning にする', () => {
    expect(transition('calibrating', { t: 'calibrated' })).toBe('earning');
    for (const state of ALL_STATES.filter((s) => s !== 'calibrating')) {
      expect(transition(state, { t: 'calibrated' })).toBe(state);
    }
  });

  it('credit-granted: earning/depleted から watching になる', () => {
    expect(transition('earning', { t: 'credit-granted' })).toBe('watching');
    expect(transition('depleted', { t: 'credit-granted' })).toBe('watching');
    for (const state of ALL_STATES.filter((s) => s !== 'earning' && s !== 'depleted')) {
      expect(transition(state, { t: 'credit-granted' })).toBe(state);
    }
  });

  it('credit-depleted: watching からのみ depleted になる', () => {
    expect(transition('watching', { t: 'credit-depleted' })).toBe('depleted');
    for (const state of ALL_STATES.filter((s) => s !== 'watching')) {
      expect(transition(state, { t: 'credit-depleted' })).toBe(state);
    }
  });

  it('user-watch/user-earn は earning⇄watching を手動で往復させる', () => {
    expect(transition('earning', { t: 'user-watch' })).toBe('watching');
    expect(transition('watching', { t: 'user-earn' })).toBe('earning');
    expect(transition('depleted', { t: 'user-watch' })).toBe('depleted'); // 残高0なので watch できない
  });

  it('tracking lost: earning/watching/calibrating から tracking-lost になる', () => {
    const lost: SessionEvent = { t: 'tracking', state: { kind: 'lost', sinceMs: 100 } };
    expect(transition('earning', lost)).toBe('tracking-lost');
    expect(transition('watching', lost)).toBe('tracking-lost');
    expect(transition('calibrating', lost)).toBe('tracking-lost');
    expect(transition('boot', lost)).toBe('boot'); // boot はまだセンサーを持たないので無関係
  });

  it('tracking ok: tracking-lost からのみ earning に復帰する。復帰後は他のフェーズに戻らない', () => {
    const ok: SessionEvent = { t: 'tracking', state: { kind: 'ok', minScore: 0.9 } };
    expect(transition('tracking-lost', ok)).toBe('earning');
    for (const state of ALL_STATES.filter((s) => s !== 'tracking-lost')) {
      expect(transition(state, ok)).toBe(state);
    }
  });

  it('low-confidence / no-sensor の tracking イベントは状態を変えない', () => {
    const low: SessionEvent = { t: 'tracking', state: { kind: 'low-confidence', minScore: 0.1 } };
    const none: SessionEvent = { t: 'tracking', state: { kind: 'no-sensor', reason: 'x' } };
    for (const state of ALL_STATES) {
      expect(transition(state, low)).toBe(state);
      expect(transition(state, none)).toBe(state);
    }
  });
});
