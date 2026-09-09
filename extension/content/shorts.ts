import type { ContentCommand, ContentNotice, ContentResult, NextStrategy, ShortsState } from '../protocol';
import { createPageLock } from './page-lock';
import {
  activeWrapperIndex,
  findScroller,
  findVideo,
  findWrappers,
  isOnShorts,
  parseOrdinal,
  pickNextOrdinal,
} from './reel-dom';

/**
 * YouTube Shorts 側の受け口。トレーナーウィンドウからの命令を DOM 操作に翻訳する。
 *
 * ★ 合成キーイベントは使えない（UI Events 仕様で untrusted event は
 * preventDefault() された扱いになり、Chrome 53 から実装済み）。「次のショートへ」は
 * scrollIntoView / scrollBy で実現するしかない — それがこのファイルの存在理由。
 *
 * ★ 再生ゲートは「pause は継続的に強制、play は命令時に一度だけ」という非対称に
 * している。YouTube は autoplay を能動的に仕掛けてくるので pause は張り付いて
 * 押さえ続ける必要があるが、play を同じ強度でやるとユーザーが自分で一時停止する
 * 自由まで奪ってしまう（クレジットを払って得た時間なので、止める権利は本人にある）。
 */

const ENFORCE_INTERVAL_MS = 250;
const NUDGE_PX = 100;
const NUDGE_SETTLE_MS = 250;

let gatePlaying = false;
let lastLockReason = '';
/** ロックした時点の位置。ロック中に位置が変わったら押し戻すための基準。 */
let lockedAtOrdinal: number | null = null;
let lastHref = location.href;
let lastStrategy: NextStrategy | undefined;

/** <video> ごとに1回だけ play リスナを張るための記録。 */
const gatedVideos = new WeakSet<HTMLVideoElement>();

const lock = createPageLock({
  onBlocked: (direction) => notify({ type: 'user-nav', direction, blocked: true }),
});

// ---------------------------------------------------------------------------
// 状態の取得
// ---------------------------------------------------------------------------

interface Position {
  readonly wrappers: readonly HTMLElement[];
  readonly activeIndex: number;
  readonly active: HTMLElement | null;
  readonly ordinal: number | null;
}

function locate(): Position {
  const wrappers = findWrappers();
  const activeIndex = activeWrapperIndex(wrappers);
  const active = activeIndex >= 0 ? (wrappers[activeIndex] ?? null) : null;
  return { wrappers, activeIndex, active, ordinal: active ? parseOrdinal(active.id) : null };
}

function currentState(): ShortsState {
  const pos = locate();
  const video = findVideo(pos.active);
  return {
    playing: !!video && !video.paused && !video.ended,
    index: pos.ordinal ?? pos.activeIndex,
    locked: lock.isLocked(),
    ...(lastStrategy ? { strategy: lastStrategy } : {}),
  };
}

function ok(): ContentResult {
  return { ok: true, state: currentState() };
}

// ---------------------------------------------------------------------------
// 再生ゲート
// ---------------------------------------------------------------------------

/**
 * この <video> に「ゲートが閉じていたら即座に止める」リスナを張る。
 * 250ms の enforce ループだけに任せると、動画が一瞬鳴ってから止まる
 * （音が出てしまうのが体験上いちばん気になる）。
 */
function gateVideo(video: HTMLVideoElement): void {
  if (gatedVideos.has(video)) return;
  gatedVideos.add(video);
  video.addEventListener(
    'play',
    () => {
      if (!gatePlaying) video.pause();
    },
    { capture: true },
  );
}

function enforce(): void {
  // SPA 遷移の監視。Shorts から離れたらロックを解いて trainer に知らせる
  // （YouTube のホームやウォッチページを人質に取り続けるのは意図しない挙動）。
  if (location.href !== lastHref) {
    lastHref = location.href;
    if (!isOnShorts()) {
      lock.setLocked(false, '');
      lockedAtOrdinal = null;
      notify({ type: 'shorts-left' });
      return;
    }
  }
  if (!isOnShorts()) return;

  // ロック中はオーバーレイが YouTube の DOM 更新で外れていないか確認する
  // （setLocked は host.isConnected を見て再 append するので冪等）。
  if (lock.isLocked()) lock.setLocked(true, lastLockReason);

  const pos = locate();
  const video = findVideo(pos.active);
  if (video) {
    gateVideo(video);
    // ★pause だけは継続的に強制する（YouTube の autoplay と戦う側）。
    if (!gatePlaying && !video.paused) video.pause();
    // 早送りでクレジットを引き延ばすのを防ぐ。
    if (video.playbackRate !== 1) video.playbackRate = 1;
  }

  // ロック中に位置がずれたら押し戻す。wheel/touch/key とクリックは page-lock が
  // 封じているが、トラックパッドの慣性スクロールや YouTube 自身の自動送りは
  // すり抜けうるので、最後の砦としてここで戻す。
  if (lock.isLocked() && lockedAtOrdinal !== null && pos.ordinal !== null && pos.ordinal !== lockedAtOrdinal) {
    const back = pos.wrappers.find((w) => parseOrdinal(w.id) === lockedAtOrdinal);
    if (back) back.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }
}

// ---------------------------------------------------------------------------
// 「次のショートへ」— 3段フォールバック
// ---------------------------------------------------------------------------

/**
 * 次のショートは事前に DOM に存在しないことがある。微小スクロールで
 * ハイドレーションを促し、位置は元に戻す（scroll-snap があれば勝手に戻るが、
 * 無い場合に 100px ずれたままになるのを避けるため明示的に復元する）。
 */
async function nudgeForHydration(scroller: HTMLElement | null): Promise<void> {
  if (!scroller) return;
  const before = scroller.scrollTop;
  scroller.scrollBy({ top: NUDGE_PX, behavior: 'auto' });
  await sleep(NUDGE_SETTLE_MS);
  if (Math.abs(scroller.scrollTop - before) > 1) {
    scroller.scrollTo({ top: before, behavior: 'auto' });
  }
}

async function goNext(): Promise<ContentResult> {
  if (!isOnShorts()) return { ok: false, error: 'not_on_shorts' };

  let pos = locate();
  const scroller = findScroller(pos.active ?? findVideo(null));

  // 戦略1: id の序数で次を引く（もっとも正確。ラッパの id に連番が入っている）
  if (pos.ordinal !== null) {
    let nextOrdinal = pickNextOrdinal(pos.ordinal, ordinalsOf(pos.wrappers));
    if (nextOrdinal === null) {
      await nudgeForHydration(scroller);
      pos = locate();
      if (pos.ordinal !== null) nextOrdinal = pickNextOrdinal(pos.ordinal, ordinalsOf(pos.wrappers));
    }
    if (nextOrdinal !== null) {
      const target = pos.wrappers.find((w) => parseOrdinal(w.id) === nextOrdinal);
      if (target) return finishNext(target, 'ordinal-id');
    }
  }

  // 戦略2: DOM 上の次の兄弟ラッパ（id の形が変わっても効く）
  if (pos.activeIndex >= 0) {
    const sibling = pos.wrappers[pos.activeIndex + 1];
    if (sibling) return finishNext(sibling, 'dom-sibling');
  }

  // 戦略3: スクロールコンテナを1画面分送る。★セレクタが全滅しても効く最後の保険。
  // scroll-snap が掛かっているので、1画面分送れば次のリールに吸着する。
  if (scroller) {
    scroller.scrollBy({ top: scroller.clientHeight, behavior: 'smooth' });
    lastStrategy = 'scroll-by-viewport';
    notify({
      type: 'selector-failure',
      detail: 'リールラッパを特定できず、1画面分スクロールで代替しました（DOM が変わった可能性）',
    });
    return ok();
  }

  const detail = `wrappers=${pos.wrappers.length} scroller=none video=${findVideo(null) ? 'yes' : 'no'}`;
  notify({ type: 'selector-failure', detail });
  return { ok: false, error: 'selector_failure', detail };
}

function finishNext(target: HTMLElement, strategy: NextStrategy): ContentResult {
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  lastStrategy = strategy;
  // 送った先を新しい基準にする（ロック中に自分で送った場合、押し戻しループに
  // 陥らせないため）。
  lockedAtOrdinal = parseOrdinal(target.id) ?? lockedAtOrdinal;
  return ok();
}

function ordinalsOf(wrappers: readonly HTMLElement[]): number[] {
  return wrappers.map((w) => parseOrdinal(w.id)).filter((n): n is number => n !== null);
}

// ---------------------------------------------------------------------------
// 命令のディスパッチ
// ---------------------------------------------------------------------------

async function handle(cmd: ContentCommand): Promise<ContentResult> {
  if (cmd.type !== 'ping' && !isOnShorts()) return { ok: false, error: 'not_on_shorts' };

  switch (cmd.type) {
    case 'ping':
      return isOnShorts() ? ok() : { ok: false, error: 'not_on_shorts' };

    case 'lock': {
      lastLockReason = cmd.reason;
      lock.setLocked(true, cmd.reason);
      lockedAtOrdinal = locate().ordinal;
      return ok();
    }
    case 'unlock':
      lock.setLocked(false, '');
      lockedAtOrdinal = null;
      return ok();

    case 'play': {
      gatePlaying = true;
      const video = findVideo(locate().active);
      if (!video) return { ok: false, error: 'no_video' };
      gateVideo(video);
      // ユーザー操作起点ではないので autoplay ポリシーで拒否されうる。ミュートは
      // しない（音が出ないショートは報酬にならない）。失敗しても状態は返す。
      await video.play().catch(() => undefined);
      return ok();
    }
    case 'pause': {
      gatePlaying = false;
      const video = findVideo(locate().active);
      video?.pause();
      return ok();
    }
    case 'next':
      return goNext();
  }
}

function notify(notice: ContentNotice): void {
  // 受け手（トレーナーページ / background）が居ないと reject するので必ず握る。
  void chrome.runtime.sendMessage({ type: 'notice', notice }).catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isContentCommand(message)) return false;
  handle(message).then(sendResponse, (err: unknown) => {
    sendResponse({ ok: false, error: 'selector_failure', detail: String(err) } satisfies ContentResult);
  });
  return true; // 非同期に応答する
});

function isContentCommand(v: unknown): v is ContentCommand {
  if (typeof v !== 'object' || v === null) return false;
  const type = (v as { type?: unknown }).type;
  return type === 'ping' || type === 'lock' || type === 'unlock' || type === 'play' || type === 'pause' || type === 'next';
}

window.setInterval(enforce, ENFORCE_INTERVAL_MS);
