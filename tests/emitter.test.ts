import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/emitter';
import type { Unsubscribe } from '../src/core/types';

interface TestEvents {
  ping: { value: number };
  pong: undefined;
}

describe('Emitter', () => {
  it('通知するのは on() したリスナーだけ', () => {
    const e = new Emitter<TestEvents>();
    const spy = vi.fn();
    e.on('ping', spy);
    e.emit('ping', { value: 1 });
    expect(spy).toHaveBeenCalledWith({ value: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('同じイベントに複数のリスナーを登録できる', () => {
    const e = new Emitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    e.on('ping', a);
    e.on('ping', b);
    e.emit('ping', { value: 2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe すると呼ばれなくなる', () => {
    const e = new Emitter<TestEvents>();
    const spy = vi.fn();
    const off = e.on('ping', spy);
    off();
    e.emit('ping', { value: 3 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('リスナーがいないイベントの emit は何もしない（例外を投げない）', () => {
    const e = new Emitter<TestEvents>();
    expect(() => e.emit('pong', undefined)).not.toThrow();
  });

  it('clear() で全リスナーが外れる', () => {
    const e = new Emitter<TestEvents>();
    const spy = vi.fn();
    e.on('ping', spy);
    e.clear();
    e.emit('ping', { value: 4 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('emit 中に別リスナーが unsubscribe してもクラッシュしない（スナップショットで反復）', () => {
    const e = new Emitter<TestEvents>();
    const calls: string[] = [];
    let offB: Unsubscribe = () => {};
    const a = vi.fn(() => offB());
    const b = vi.fn(() => calls.push('b'));
    e.on('ping', a);
    offB = e.on('ping', b);
    expect(() => e.emit('ping', { value: 5 })).not.toThrow();
    // a が先に登録されているので、同一 emit 内では b はスナップショット済みでまだ呼ばれる
    expect(calls).toEqual(['b']);
  });
});
