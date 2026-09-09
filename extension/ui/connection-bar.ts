import type { ShortsSliderStatus } from '../shorts-extension-slider';

export interface ConnectionBarOptions {
  readonly onOpenShorts: () => void;
}

export interface ConnectionBar {
  update(status: ShortsSliderStatus): void;
}

/**
 * Shorts 側との接続状態バー。
 *
 * ★ これは飾りではない。トレーナーウィンドウと YouTube のタブは別プロセスなので、
 * 「レップは数えているのに動画が動かない」ときの原因が
 *   (a) タブが開いていない / (b) content script が死んでいる /
 *   (c) セレクタが壊れた / (d) そもそもレップが出ていない
 * のどれなのか、これが無いと切り分けられない。M4 の dev パネルと同じ位置づけ。
 */
export function createConnectionBar(root: HTMLElement, opts: ConnectionBarOptions): ConnectionBar {
  const bar = document.createElement('div');
  bar.className = 'dt-conn';
  bar.innerHTML = `
    <span class="dt-conn__dot" data-el="dot"></span>
    <span class="dt-conn__message" data-el="message">未接続</span>
    <span class="dt-conn__strategy" data-el="strategy"></span>
    <button type="button" class="dt-conn__button" data-el="open">Shorts を開く</button>
  `;
  root.appendChild(bar);

  const dot = bar.querySelector<HTMLElement>('[data-el="dot"]');
  const message = bar.querySelector<HTMLElement>('[data-el="message"]');
  const strategy = bar.querySelector<HTMLElement>('[data-el="strategy"]');
  bar.querySelector<HTMLButtonElement>('[data-el="open"]')?.addEventListener('click', opts.onOpenShorts);

  let lastMessage: string | null = null;
  let lastConnected: boolean | null = null;
  let lastStrategy: string | null = null;

  return {
    update(status: ShortsSliderStatus): void {
      if (lastConnected !== status.connected) {
        lastConnected = status.connected;
        bar.dataset.connected = String(status.connected);
        if (dot) dot.textContent = status.connected ? '●' : '○';
      }
      if (lastMessage !== status.message) {
        lastMessage = status.message;
        if (message) message.textContent = status.message;
      }
      // next() がどの戦略で通ったかを常に見せる。'scroll-by-viewport' が出続けたら
      // リールラッパのセレクタが劣化した合図（1画面分スクロールの保険で動いている）。
      const nextStrategy = status.strategy ?? '';
      if (lastStrategy !== nextStrategy) {
        lastStrategy = nextStrategy;
        if (strategy) {
          strategy.textContent = nextStrategy === '' ? '' : `next: ${nextStrategy}`;
          strategy.dataset.degraded = String(nextStrategy === 'scroll-by-viewport');
        }
      }
    },
  };
}
