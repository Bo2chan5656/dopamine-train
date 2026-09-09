/**
 * YouTube のページ内でスクロールと操作を封じるロック。
 *
 * ★ 対象が「他人のページ」であることが実装を決めている。自前のページなら
 * preventDefault() で既定のスクロール挙動を止めれば済むが、YouTube は自身の JS が
 * wheel/keydown を購読して独自に scrollIntoView してくるため、
 * **stopImmediatePropagation() で YouTube のリスナごと止める必要がある**。
 * （かつて自前プレイヤー用に preventDefault() だけの scroll-lock.ts があったが、
 * YouTube Shorts に一本化したため削除した。）
 *
 * イベントは window の capture フェーズで拾う — capture の順序は
 * window → document → … → target なので、document に登録されている YouTube の
 * リスナより先に走り、そこで伝播を止められる。
 *
 * ポインタ操作（上下送りボタンのクリック、動画のタップ）はイベント個別に潰すのが
 * 現実的でないので、全画面オーバーレイで物理的に覆う。オーバーレイは Shadow DOM に
 * 入れる — YouTube の CSS は攻撃的なので、通常の DOM に置くと打ち消される。
 */

const BLOCKED_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'PageDown',
  'PageUp',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);
const FORWARD_KEYS = new Set(['ArrowDown', 'PageDown', 'End', ' ', 'Spacebar']);

export interface PageLockOptions {
  /** 実際にブロックした瞬間に呼ばれる。trainer 側に「ロック中です」を出すのに使う。 */
  readonly onBlocked: (direction: 1 | -1) => void;
}

export interface PageLock {
  setLocked(locked: boolean, reason: string): void;
  isLocked(): boolean;
  dispose(): void;
}

export function createPageLock(opts: PageLockOptions): PageLock {
  let locked = false;
  const { host, setMessage } = createOverlay();

  function block(e: Event, direction: 1 | -1): void {
    e.preventDefault();
    e.stopPropagation();
    // ★これが本質。YouTube 自身の wheel/keydown ハンドラを走らせない。
    e.stopImmediatePropagation();
    opts.onBlocked(direction);
  }

  function onWheel(e: WheelEvent): void {
    if (!locked) return;
    block(e, e.deltaY > 0 ? 1 : -1);
  }
  function onTouch(e: TouchEvent): void {
    if (!locked) return;
    block(e, 1); // タッチの向きまでは追わない。ブロックした事実だけ伝える
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (!locked) return;
    if (isEditableTarget(e.target)) return; // 検索欄などでの入力は邪魔しない
    if (!BLOCKED_KEYS.has(e.key)) return;
    block(e, FORWARD_KEYS.has(e.key) ? 1 : -1);
  }

  // passive:false を忘れると wheel/touchmove で preventDefault() が効かない。
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('touchmove', onTouch, { capture: true, passive: false });
  window.addEventListener('touchstart', onTouch, { capture: true, passive: false });
  window.addEventListener('keydown', onKeyDown, { capture: true });

  return {
    setLocked(next: boolean, reason: string): void {
      locked = next;
      setMessage(reason);
      if (next) {
        if (!host.isConnected) document.documentElement.appendChild(host);
      } else {
        host.remove();
      }
    },
    isLocked(): boolean {
      return locked;
    },
    dispose(): void {
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('touchmove', onTouch, { capture: true });
      window.removeEventListener('touchstart', onTouch, { capture: true });
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      host.remove();
    },
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * ロック中の全画面オーバーレイ。Shadow DOM に入れて YouTube の CSS から隔離する。
 * ホスト要素自体のレイアウトは cssText + !important で直接指定する（ホストは
 * ページ側の DOM ツリーにいるので、こちらもページ CSS の影響を受けうる）。
 */
function createOverlay(): { host: HTMLDivElement; setMessage: (text: string) => void } {
  const host = document.createElement('div');
  host.style.cssText = [
    'position: fixed !important',
    'inset: 0 !important',
    'z-index: 2147483647 !important',
    'display: block !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'border: 0 !important',
    'pointer-events: auto !important',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .backdrop {
        position: absolute; inset: 0;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 0.75rem;
        background: rgba(0, 0, 0, 0.78);
        font-family: system-ui, -apple-system, sans-serif;
        color: #f5f5f5;
        text-align: center;
        padding: 2rem;
        box-sizing: border-box;
      }
      .icon { font-size: 4rem; line-height: 1; }
      /* 2m 離れた場所から読める必要がある（M1 の HUD と同じ制約）。 */
      .reason { font-size: 2rem; font-weight: 700; color: #f87171; }
      .hint { font-size: 1rem; color: #a3a3a3; }
    </style>
    <div class="backdrop">
      <div class="icon">🏋️</div>
      <div class="reason" data-el="reason"></div>
      <div class="hint">Dopamine Train — トレーナーウィンドウでレップをこなしてください</div>
    </div>
  `;

  const reasonEl = shadow.querySelector<HTMLElement>('[data-el="reason"]');
  return {
    host,
    setMessage(text: string): void {
      if (reasonEl) reasonEl.textContent = text;
    },
  };
}
