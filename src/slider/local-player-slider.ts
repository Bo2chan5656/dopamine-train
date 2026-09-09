import { Emitter } from '../core/emitter';
import { createFeed, type Feed } from '../player/feed';
import type { VideoItem } from '../player/library';
import { createScrollLock, type ScrollLock } from '../player/scroll-lock';
import type { Slider, SliderEvents } from './slider';

export interface LocalPlayerSlider extends Slider {
  setItems(items: readonly VideoItem[]): void;
}

/**
 * 自前の縦型プレイヤー（ローカル動画 + scroll-snap）。feed.ts が Shorts と同型の
 * 構造を持つため、M6+ の Chrome 拡張化ではこのクラスの代わりに shorts-extension
 * 実装（chrome.tabs.sendMessage 越し）に差し替えるだけで済む設計になっている。
 */
export function createLocalPlayerSlider(root: HTMLElement): LocalPlayerSlider {
  const events = new Emitter<SliderEvents>();
  let feed: Feed | null = null;
  let scrollLock: ScrollLock | null = null;
  let feedRoot: HTMLDivElement | null = null;
  let pendingItems: readonly VideoItem[] = [];
  let wantPlaying = false;

  function currentVideo(): HTMLVideoElement | null {
    return feed?.currentVideoElement() ?? null;
  }

  function applyPlayState(): void {
    const video = currentVideo();
    if (!video) return;
    if (wantPlaying) {
      video.play().catch(() => {
        // 自動再生ポリシーで拒否される場合がある。j/k キー押下自体がユーザー操作
        // なので通常は成功するが、失敗しても無音でクラッシュしないようにする。
      });
    } else {
      video.pause();
    }
  }

  return {
    kind: 'local-player',
    events,

    async attach(): Promise<void> {
      feedRoot = document.createElement('div');
      feedRoot.className = 'dt-feed-root';
      root.appendChild(feedRoot);
      feed = createFeed(feedRoot, {
        onIndexChange: (index) => {
          applyPlayState();
          events.emit('state', { playing: wantPlaying, index });
        },
        onVideoMounted: (video, index) => {
          video.addEventListener('ended', () => {
            events.emit('ended', { index });
            if (wantPlaying) feed?.next();
          });
        },
      });
      scrollLock = createScrollLock(feedRoot, {
        onBlocked: (direction) => events.emit('user-nav', { direction, blocked: true }),
      });
      if (pendingItems.length > 0) feed.setItems(pendingItems);
    },

    async detach(): Promise<void> {
      scrollLock?.dispose();
      feed?.dispose();
      feedRoot?.remove();
      feed = null;
      scrollLock = null;
      feedRoot = null;
    },

    async play(): Promise<void> {
      wantPlaying = true;
      applyPlayState();
      events.emit('state', { playing: true, index: feed?.currentIndex ?? 0 });
    },
    async pause(_reason): Promise<void> {
      wantPlaying = false;
      applyPlayState();
      events.emit('state', { playing: false, index: feed?.currentIndex ?? 0 });
    },
    setLocked(locked: boolean, _reason?: string): void {
      scrollLock?.setLocked(locked);
    },
    async next(_reason): Promise<void> {
      feed?.next();
    },
    isPlaying(): boolean {
      const video = currentVideo();
      return wantPlaying && !!video && !video.paused;
    },

    setItems(items: readonly VideoItem[]): void {
      pendingItems = items;
      feed?.setItems(items);
    },
  };
}
