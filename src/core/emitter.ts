import type { Unsubscribe } from './types';

/**
 * 型付きイベントエミッタ。RepSource / CreditLedger / Slider の3境界にだけ使う。
 * 文字列キーのグローバルイベントバスは意図的に作らない — 誰が emit しているかが
 * 追えなくなり、この規模ではデバッグコストが便益を上回るため（設計判断は plan 参照）。
 *
 * Events の制約は `object`（`Record<string, unknown>` にしない）: interface で書いた
 * イベントマップは index signature を持たないため、Record 制約だと呼び出し側で
 * "does not satisfy the constraint" エラーになる（TSの既知の挙動）。
 */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(payload: unknown) => void>>();

  on<K extends keyof Events>(key: K, fn: (payload: Events[K]) => void): Unsubscribe {
    const set = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, set);
    const wrapped = fn as (payload: unknown) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  emit<K extends keyof Events>(key: K, payload: Events[K]): void {
    const set = this.listeners.get(key);
    if (!set || set.size === 0) return;
    // スナップショットを取ってから反復する: リスナー内で on/off されても壊れない。
    for (const fn of Array.from(set)) fn(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
