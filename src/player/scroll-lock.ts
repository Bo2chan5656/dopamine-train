export interface ScrollLock {
  setLocked(locked: boolean): void;
  dispose(): void;
}

export interface ScrollLockOptions {
  /** ロック中に実際にブロックした瞬間に呼ばれる（UI が「ロック中です」を出す等に使う）。 */
  readonly onBlocked?: (direction: 1 | -1) => void;
}

// スペース/矢印/PageUp・Downによるスクロールを対象にする。
const BLOCKED_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Spacebar']);
const FORWARD_KEYS = new Set(['ArrowDown', 'PageDown', ' ', 'Spacebar']);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * クレジット枯渇時にフィードのスクロールを封じる。合成イベントの isTrusted 問題とは
 * 無関係の話（ここは自分のページなので、直接 DOM を操作する側）— 対象は「本物の
 * ユーザー入力」を preventDefault() で止めること。wheel/touchmove は capture+non-passive
 * でないと preventDefault() が効かない（{passive:false} を忘れると wheel が抜ける）。
 *
 * keydown は document 単位で拾う（フィードにフォーカスが無くても止めるため）が、
 * 設定パネルの number input 等での上下矢印/Space 入力までは邪魔しない。
 */
export function createScrollLock(target: HTMLElement, opts: ScrollLockOptions = {}): ScrollLock {
  let locked = false;

  function onWheel(e: WheelEvent): void {
    if (!locked) return;
    e.preventDefault();
    opts.onBlocked?.(e.deltaY > 0 ? 1 : -1);
  }
  function onTouchMove(e: TouchEvent): void {
    if (!locked) return;
    e.preventDefault();
    opts.onBlocked?.(1); // タッチの正確な向きまでは追わない。ブロックした事実だけ伝える。
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (!locked) return;
    if (isEditableTarget(e.target)) return;
    if (!BLOCKED_KEYS.has(e.key)) return;
    e.preventDefault();
    opts.onBlocked?.(FORWARD_KEYS.has(e.key) ? 1 : -1);
  }

  target.addEventListener('wheel', onWheel, { capture: true, passive: false });
  target.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  document.addEventListener('keydown', onKeyDown, { capture: true });

  return {
    setLocked(v: boolean): void {
      locked = v;
    },
    dispose(): void {
      target.removeEventListener('wheel', onWheel, { capture: true });
      target.removeEventListener('touchmove', onTouchMove, { capture: true });
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    },
  };
}
