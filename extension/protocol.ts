/**
 * トレーナーページ ↔ background ↔ content script の間で交換するメッセージの型。
 *
 * ★ このファイルは chrome.* にも DOM にも触らない — 3者が同じ型定義を共有する
 * ためだけに存在する（型が食い違うとメッセージが黙って無視されるという、
 * 一番デバッグしにくい種類のバグになる）。
 */

/** content script に対する命令。Slider インターフェースの各メソッドに1対1で対応する。 */
export type ContentCommand =
  | { readonly type: 'ping' }
  | { readonly type: 'lock'; readonly reason: string }
  | { readonly type: 'unlock' }
  | { readonly type: 'play' }
  | { readonly type: 'pause'; readonly reason: string }
  | { readonly type: 'next' };

export interface ShortsState {
  readonly playing: boolean;
  /**
   * フィード内の現在位置。YouTube のリールラッパの `id` 属性（序数が入る）を
   * 数値化したもの。取れない場合は -1。SPA 遷移で振り直されることがあるので
   * 「連番であること」に依存した処理は書かない（差分の検出にだけ使う）。
   */
  readonly index: number;
  readonly locked: boolean;
  /** next() がどの戦略で成功したか。セレクタ劣化の早期警告として trainer に出す。 */
  readonly strategy?: NextStrategy;
}

/** next() の3段フォールバック。どれで成功したかを記録して劣化を可視化する。 */
export type NextStrategy = 'ordinal-id' | 'dom-sibling' | 'scroll-by-viewport';

export type ContentError =
  /** リールラッパも <video> も、スクロールコンテナすら見つからない = DOM が変わった */
  | 'selector_failure'
  /** ラッパは見つかるが <video> が無い（ハイドレーション途中など、リトライ可能） */
  | 'no_video'
  /** 最後のショートに到達した（エラーではないが next は成立しない） */
  | 'no_next'
  /** youtube.com にはいるが /shorts/ を開いていない */
  | 'not_on_shorts';

export type ContentResult =
  | { readonly ok: true; readonly state: ShortsState }
  | { readonly ok: false; readonly error: ContentError; readonly detail?: string };

/** trainer → background。background は tabId の解決とウィンドウ管理だけを担う。 */
export type BackgroundRequest =
  | { readonly type: 'to-content'; readonly cmd: ContentCommand }
  /** Shorts のタブを前面に出す（無ければ新規に開く）。 */
  | { readonly type: 'ensure-shorts-tab' };

export type BackgroundResult =
  | ContentResult
  /** 'ensure-shorts-tab' の応答。既存タブを前面に出したか、新規に開いたか。 */
  | { readonly ok: true; readonly action: 'focused' | 'created' }
  /** youtube.com/shorts のタブが1つも開いていない */
  | { readonly ok: false; readonly error: 'no_tab'; readonly detail?: string }
  /** content script が応答しない（拡張のリロード直後にページを再読込していない等） */
  | { readonly ok: false; readonly error: 'no_content_script'; readonly detail?: string };

/** BackgroundResult のうち、content script が実際に状態を返したものだけに絞る。 */
export function hasShortsState(r: BackgroundResult): r is { ok: true; state: ShortsState } {
  return r.ok && 'state' in r;
}

/**
 * content script → background → trainer への非同期通知（命令の応答ではない）。
 * ロック中にユーザーが強引にスクロールした、SPA 遷移で Shorts から離れた、等。
 */
export type ContentNotice =
  | { readonly type: 'user-nav'; readonly direction: 1 | -1; readonly blocked: boolean }
  | { readonly type: 'shorts-left' }
  | { readonly type: 'selector-failure'; readonly detail: string };

export interface NoticeEnvelope {
  readonly type: 'notice';
  readonly notice: ContentNotice;
}

export function isNoticeEnvelope(v: unknown): v is NoticeEnvelope {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'notice';
}

/** youtube.com/shorts のタブを探すための match パターン。background と manifest で共有する。 */
export const SHORTS_URL_PATTERNS = ['*://www.youtube.com/shorts/*', '*://m.youtube.com/shorts/*'] as const;
export const SHORTS_HOME_URL = 'https://www.youtube.com/shorts';
