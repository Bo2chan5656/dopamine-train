import { describe, expect, it } from 'vitest';
import { parseOrdinal, pickNextOrdinal } from '../extension/content/reel-dom';

/**
 * reel-dom.ts の純粋ロジックだけをテストする。DOM 探索部分（findWrappers /
 * activeWrapperIndex 等）は YouTube の実 DOM が相手なのでここでは検証しない —
 * 「他人のページの構造」をモックしたテストは、モックが実物とずれた瞬間に
 * 嘘の安心をくれるだけになる。あちらは README の手動チェックで見る。
 */

describe('parseOrdinal', () => {
  it('YouTube の連番 id をそのまま数値にする', () => {
    expect(parseOrdinal('0')).toBe(0);
    expect(parseOrdinal('7')).toBe(7);
    expect(parseOrdinal('123')).toBe(123);
  });

  it('接頭辞が付いた形でも末尾の数字を拾う（id の命名が変わっても耐える）', () => {
    expect(parseOrdinal('reel-video-3')).toBe(3);
    expect(parseOrdinal('shorts_slide_42')).toBe(42);
  });

  it('末尾に数字が無い / 空 / null は null を返す', () => {
    expect(parseOrdinal('reel-video')).toBeNull();
    expect(parseOrdinal('')).toBeNull();
    expect(parseOrdinal(null)).toBeNull();
    expect(parseOrdinal(undefined)).toBeNull();
  });
});

describe('pickNextOrdinal', () => {
  it('現在より大きい中で最小のものを選ぶ', () => {
    expect(pickNextOrdinal(2, [0, 1, 2, 3, 4])).toBe(3);
  });

  it('★歯抜けでも1つ進む（ウィンドウ外のラッパが解体されて連番が崩れるケース）', () => {
    // current+1 を決め打ちしていると、4 が存在しないここで止まってしまう。
    expect(pickNextOrdinal(3, [3, 7, 9])).toBe(7);
  });

  it('順序が入れ替わって渡されても最小の「次」を選ぶ', () => {
    expect(pickNextOrdinal(3, [9, 5, 7])).toBe(5);
  });

  it('次が無ければ null（最後のショートに到達＝まだハイドレートされていない）', () => {
    expect(pickNextOrdinal(9, [3, 7, 9])).toBeNull();
    expect(pickNextOrdinal(0, [])).toBeNull();
  });

  it('自分と同じ序数は「次」にしない（押し戻しループの防止）', () => {
    expect(pickNextOrdinal(5, [5, 5, 5])).toBeNull();
  });
});
