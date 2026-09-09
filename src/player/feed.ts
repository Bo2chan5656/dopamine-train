import type { VideoItem } from './library';
import './feed.css';

export interface FeedOptions {
  /** ユーザーの手動スクロール・goTo/next/previous のどちらでも、現在地が変わるたびに呼ばれる。 */
  readonly onIndexChange?: (index: number) => void;
  /** ウィンドウ内に入り <video> が実体化された瞬間に一度だけ呼ばれる（'ended' 等を配線する用）。 */
  readonly onVideoMounted?: (video: HTMLVideoElement, index: number) => void;
}

export interface Feed {
  readonly currentIndex: number;
  readonly length: number;
  setItems(items: readonly VideoItem[]): void;
  goTo(index: number): void;
  next(): void;
  previous(): void;
  currentVideoElement(): HTMLVideoElement | null;
  dispose(): void;
}

const WINDOW_RADIUS = 1; // 可視スライドの前後1つだけ <video> を実体化する

/**
 * Shorts と同型の縦積みフィード。<video> は currentIndex の前後1つ（±1）だけ
 * マウントする — 多数の動画を読み込んでもメモリ（デコードバッファ）が膨らまない。
 *
 * ★ library.ts は追記のみ・全消去のみを行う前提（items と slides の並びを
 * インデックスで対応させ続けるため）。並べ替え/個別削除を追加する場合は
 * setItems() の差分ロジックを見直すこと。
 */
export function createFeed(root: HTMLElement, opts: FeedOptions = {}): Feed {
  const container = document.createElement('div');
  container.className = 'dt-feed';
  root.appendChild(container);

  let items: readonly VideoItem[] = [];
  let slides: HTMLDivElement[] = [];
  let currentIndex = 0;
  let suppressObserver = false; // プログラム側の scrollIntoView による誤検出を防ぐ

  const observer = new IntersectionObserver(
    (entries) => {
      if (suppressObserver) return;
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          const idx = slides.indexOf(entry.target as HTMLDivElement);
          if (idx !== -1 && idx !== currentIndex) {
            currentIndex = idx;
            hydrateWindow();
            opts.onIndexChange?.(currentIndex);
          }
        }
      }
    },
    { root: container, threshold: [0.6] },
  );

  function hydrateWindow(): void {
    slides.forEach((slide, i) => {
      const withinWindow = Math.abs(i - currentIndex) <= WINDOW_RADIUS;
      const item = items[i];
      if (withinWindow && item) {
        if (!slide.querySelector('video')) {
          const video = document.createElement('video');
          video.src = item.url;
          video.className = 'dt-feed__video';
          video.playsInline = true;
          video.preload = 'auto';
          slide.appendChild(video);
          opts.onVideoMounted?.(video, i);
        }
      } else if (slide.firstChild) {
        slide.innerHTML = ''; // ウィンドウ外: <video> を解体してデコード資源を解放する
      }
    });
  }

  function scrollToCurrent(behavior: ScrollBehavior): void {
    const slide = slides[currentIndex];
    if (!slide) return;
    suppressObserver = true;
    slide.scrollIntoView({ behavior, block: 'nearest' });
    window.setTimeout(
      () => {
        suppressObserver = false;
      },
      behavior === 'smooth' ? 400 : 50,
    );
  }

  function setIndex(index: number, behavior: ScrollBehavior): void {
    const clamped = Math.max(0, Math.min(items.length - 1, index));
    if (clamped === currentIndex || items.length === 0) return;
    currentIndex = clamped;
    hydrateWindow();
    scrollToCurrent(behavior);
    opts.onIndexChange?.(currentIndex);
  }

  return {
    get currentIndex() {
      return currentIndex;
    },
    get length() {
      return items.length;
    },

    setItems(newItems: readonly VideoItem[]): void {
      const previousItems = items;
      const newIds = new Set(newItems.map((it) => it.id));
      const existingIds = new Set(previousItems.map((it) => it.id));
      items = newItems;

      for (let i = slides.length - 1; i >= 0; i--) {
        const slide = slides[i];
        const id = slide?.dataset.itemId;
        if (slide && id !== undefined && !newIds.has(id)) {
          observer.unobserve(slide);
          slide.remove();
          slides.splice(i, 1);
        }
      }
      for (const item of newItems) {
        if (!existingIds.has(item.id)) {
          const slide = document.createElement('div');
          slide.className = 'dt-feed__slide';
          slide.dataset.itemId = item.id;
          container.appendChild(slide);
          slides.push(slide);
          observer.observe(slide);
        }
      }

      currentIndex = Math.min(currentIndex, Math.max(0, items.length - 1));
      hydrateWindow();
      if (previousItems.length === 0 && items.length > 0) {
        scrollToCurrent('auto');
      }
    },

    goTo(index: number): void {
      setIndex(index, 'smooth');
    },
    next(): void {
      setIndex(currentIndex + 1, 'smooth');
    },
    previous(): void {
      setIndex(currentIndex - 1, 'smooth');
    },
    currentVideoElement(): HTMLVideoElement | null {
      return slides[currentIndex]?.querySelector('video') ?? null;
    },
    dispose(): void {
      observer.disconnect();
      container.remove();
    },
  };
}
