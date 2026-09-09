/**
 * YouTube Shorts の DOM 探索。
 *
 * ★ ここが拡張全体で唯一の「壊れる」ファイル。Shorts の DOM は実運用拡張の
 * コミット履歴を見る限り平均2〜3か月ごとに変わる（2025-04, 05, 06, 12 /
 * 2026-02, 06, 08 にセレクタ修正が入っている）。壊れたときにここ1ファイルだけを
 * 直せば済むよう、DOM に関する知識を全部このファイルに閉じ込める。
 *
 * 設計方針:
 *  1. **セレクタよりも幾何とスクロールを信じる**。「どれが現在のリールか」は
 *     `is-active` 等の属性ではなく「ビューポート中央に一番近い要素」で決める —
 *     属性名は変わるが「画面中央に見えているものが現在地」は変わらない。
 *  2. **クラス名は複数候補のフォールバック連鎖**にする。
 *  3. **全滅したら黙って諦めず 'selector_failure' を返す**。サイレント失敗は
 *     「動かないが理由が分からない」を生み、それがこの手のツールを殺す。
 *
 * ★ このファイルはトップレベルで DOM に触らない（関数の中だけ）。純粋ロジック
 * （序数の計算）を vitest の environment:'node' からテストするため。
 */

/** 2026-09 時点で観測されている候補。上から順に試す。 */
export const REEL_SELECTORS = {
  /** 1本のショートを包むラッパ。新DOM は `-new` 付き。 */
  wrapper: ['.reel-video-in-sequence-new', '.reel-video-in-sequence', 'ytd-reel-video-renderer'],
  /**
   * 縦スクロールのコンテナ。
   *
   * ★ `#shorts-container` が正解。`#shorts-inner-container` は紛らわしいが
   * `overflow-y: visible` の内側要素で、scrollBy しても1pxも動かない
   * （2026-09-09 に実機の youtube.com/shorts で全候補を総当たりして確認:
   * #shorts-container だけが scrollTop 0→820 で動き、リールも 0→1 に進んだ。
   * documentElement / window は8pxしか動かずリールは進まない）。
   * ここを間違えると「戦略3のフォールバックが黙って何もしない」＝保険が
   * 効いていないのに効いているつもりになる、という最悪の状態になる。
   */
  scroller: ['#shorts-container', 'ytd-shorts #shorts-container', '#shorts-inner-container', 'ytd-shorts'],
  /** 再生中の <video>。html5-main-video は YouTube プレイヤー共通。 */
  video: ['video.html5-main-video', 'video'],
  /** 上下送りボタン。ロック中に潰す対象。 */
  navButton: ['#navigation-button-down', '#navigation-button-up', '.navigation-container'],
} as const satisfies Record<string, readonly string[]>;

// ---------------------------------------------------------------------------
// 純粋ロジック（DOM 非依存・テスト対象）
// ---------------------------------------------------------------------------

/**
 * リールラッパの `id` 属性から序数を取り出す。YouTube は `id="0"`, `id="1"` …
 * のように連番を入れてくるが、将来 `reel-video-3` のような形になっても拾えるよう
 * 「末尾の連続する数字」を取る。
 */
export function parseOrdinal(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = /(\d+)\s*$/.exec(id);
  const digits = m?.[1];
  if (digits === undefined) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 現在の序数より大きい中で最小の序数を選ぶ。
 *
 * 単純な `current + 1` にしないのは、DOM 上のラッパが必ず連番で存在するとは
 * 限らないため（ウィンドウ外が解体されて歯抜けになる / 先読みで飛び番になる）。
 * 「次に大きいもの」を取れば、歯抜けでも飛び番でも正しく1つ進む。
 */
export function pickNextOrdinal(current: number, available: readonly number[]): number | null {
  let best: number | null = null;
  for (const n of available) {
    if (n > current && (best === null || n < best)) best = n;
  }
  return best;
}

// ---------------------------------------------------------------------------
// DOM 探索（フォールバック連鎖）
// ---------------------------------------------------------------------------

/** 候補セレクタを順に試し、最初に1件以上マッチしたものの結果を返す。 */
export function queryAllFirstMatch(candidates: readonly string[], root: ParentNode = document): HTMLElement[] {
  for (const sel of candidates) {
    const found = Array.from(root.querySelectorAll<HTMLElement>(sel));
    if (found.length > 0) return found;
  }
  return [];
}

export function queryFirstMatch(candidates: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const sel of candidates) {
    const found = root.querySelector<HTMLElement>(sel);
    if (found) return found;
  }
  return null;
}

/** 現在 /shorts/ を開いているか。SPA なので URL は随時変わる。 */
export function isOnShorts(): boolean {
  return location.pathname.startsWith('/shorts');
}

export function findWrappers(): HTMLElement[] {
  return queryAllFirstMatch(REEL_SELECTORS.wrapper);
}

/**
 * ビューポート中央に一番近いラッパの添字を返す。★属性名に依存しない中核ロジック。
 * 高さ0の要素（解体済み/未ハイドレーション）は候補から外す。
 */
export function activeWrapperIndex(wrappers: readonly HTMLElement[]): number {
  const viewportCenter = window.innerHeight / 2;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  wrappers.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 1) return;
    const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  });
  return bestIndex;
}

/**
 * 縦スクロールのコンテナ。候補セレクタを順に**機能テストしながら**試し、全滅したら
 * 起点要素から祖先を辿る（クラス名にも id にも一切依存しない最終保険）。
 */
export function findScroller(from: HTMLElement | null): HTMLElement | null {
  for (const sel of REEL_SELECTORS.scroller) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (isScrollable(el)) return el;
    }
  }

  let node: HTMLElement | null = from;
  while (node && node !== document.body) {
    if (isScrollable(node)) return node;
    node = node.parentElement;
  }

  const root = document.scrollingElement;
  return root instanceof HTMLElement && isScrollable(root) ? root : null;
}

/**
 * 「この要素は本当にスクロールするのか」を**実際に1px動かして確かめる**。
 *
 * ★ getComputedStyle().overflowY を見る実装から差し替えた。実機の
 * #shorts-inner-container は overflow-y:visible なのに scrollHeight が
 * clientHeight の17倍あり、「オーバーフローしているから scroll できるはず」も
 * 「overflow の値で判定する」もどちらも実物に対して間違った答えを出した。
 * scrollTop への代入が通るかどうかは仕様上スクロールコンテナかどうかと
 * 等価なので、これがクラス名にも CSS の書き方にも依存しない唯一の判定になる。
 * 1px の移動は即座に戻すので体感できない。
 */
function isScrollable(el: HTMLElement): boolean {
  if (el.scrollHeight - el.clientHeight <= 20) return false;
  const before = el.scrollTop;
  // 一番上に居るときは +1、それ以外は -1（下端に張り付いている場合に +1 が
  // 効かないケースを避ける）。
  el.scrollTop = before === 0 ? before + 1 : before - 1;
  const moved = el.scrollTop !== before;
  if (moved) el.scrollTop = before;
  return moved;
}

/**
 * 現在のリールの <video>。ラッパ内を優先し、無ければページ全体から探す
 * （ハイドレーション途中はラッパ内に <video> がまだ無いことがある）。
 */
export function findVideo(wrapper: HTMLElement | null): HTMLVideoElement | null {
  if (wrapper) {
    const inWrapper = queryFirstMatch(REEL_SELECTORS.video, wrapper);
    if (inWrapper instanceof HTMLVideoElement) return inWrapper;
  }
  const anywhere = queryFirstMatch(REEL_SELECTORS.video);
  return anywhere instanceof HTMLVideoElement ? anywhere : null;
}

/** ロック中に潰す上下送りボタン。見つからなくても致命的ではない。 */
export function findNavButtons(): HTMLElement[] {
  return REEL_SELECTORS.navButton.flatMap((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)));
}
