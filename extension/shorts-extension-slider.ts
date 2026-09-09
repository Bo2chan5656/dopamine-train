import { Emitter } from '../src/core/emitter';
import type { Slider, SliderEvents } from '../src/slider/slider';
import type { BackgroundRequest, BackgroundResult, ContentCommand, NextStrategy } from './protocol';
import { hasShortsState, isNoticeEnvelope } from './protocol';

export interface ShortsSliderStatus {
  readonly connected: boolean;
  /** UI にそのまま出す日本語メッセージ。 */
  readonly message: string;
  /** next() がどの戦略で通ったか。'scroll-by-viewport' が続くならセレクタ劣化の合図。 */
  readonly strategy?: NextStrategy;
}

export interface ShortsSliderOptions {
  readonly onStatus?: (status: ShortsSliderStatus) => void;
  /** 再生状態のポーリング間隔。既定1秒（理由は下のコメント参照）。 */
  readonly pollIntervalMs?: number;
}

export interface ShortsExtensionSlider extends Slider {
  status(): ShortsSliderStatus;
  /** Shorts のタブを前面に出す（無ければ開く）。トレーナー UI のボタンから呼ぶ。 */
  ensureShortsTab(): Promise<void>;
}

const ERROR_JA: Record<string, string> = {
  no_tab: 'YouTube Shorts のタブが開いていません',
  no_content_script: 'Shorts のページを再読み込みしてください（拡張を更新した直後など）',
  not_on_shorts: 'youtube.com/shorts を開いてください',
  selector_failure: '⚠ Shorts の構造が変わりました（reel-dom.ts のセレクタ更新が必要）',
  no_video: '動画の読み込み中です…',
  no_next: '次のショートが見つかりません',
};

/**
 * 拡張のコンテキストで動いているか（= chrome.runtime.sendMessage が使えるか）。
 *
 * `npm run dev` の localhost では chrome.* が存在しない。トレーナーページは
 * キャリブレーション/HUD/カメラの反復用に localhost でも開けるようにしてあるので、
 * ここで落ちるとページ全体がブートしなくなる — 素通しして接続バーに理由を出す。
 */
function inExtension(): boolean {
  return typeof chrome !== 'undefined' && chrome.runtime?.id !== undefined;
}

const NOT_IN_EXTENSION: ShortsSliderStatus = {
  connected: false,
  message: 'localhost では Shorts を操作できません（npm run build:ext して拡張として読み込む）',
};

/**
 * YouTube Shorts を対象にした Slider。各メソッドは content script への
 * メッセージ1回に落ちる。
 *
 * ★ 命令を内部キューで直列化している。chrome.runtime.sendMessage の応答順序は
 * 保証されないため、per-slide 方式で走る `unlock → next → play` の3連が並行して
 * 飛ぶと「ロック解除前に送ろうとして押し戻される」等の競合が起きる。
 *
 * ★ isPlaying() は Slider インターフェース上は同期メソッドだが、真の再生状態は
 * 別プロセス（YouTube のタブ）にある。したがってここでは**直近に判明した値を
 * キャッシュして返す**。SessionController.tick() はこの値でクレジット消費を
 * 決めるので、キャッシュが古いと消費が実態からずれる — それを抑えるために
 * 1秒ごとに ping して同期する。ずれは最大1秒（YouTube 側で手動一時停止した
 * 場合に1秒分だけ余分に消費されうる）。
 */
export function createShortsExtensionSlider(opts: ShortsSliderOptions = {}): ShortsExtensionSlider {
  const events = new Emitter<SliderEvents>();
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;

  let queue: Promise<unknown> = Promise.resolve();
  let cachedPlaying = false;
  let cachedIndex = -1;
  let wantPlaying = false;
  let status: ShortsSliderStatus = { connected: false, message: '未接続' };
  let pollTimer: number | null = null;

  function setStatus(next: ShortsSliderStatus): void {
    status = next;
    opts.onStatus?.(next);
  }

  /** 命令を直列に投げる。失敗しても throw せず status に落とす（UI が固まらないように）。 */
  function send(cmd: ContentCommand): Promise<BackgroundResult | null> {
    const run = async (): Promise<BackgroundResult | null> => {
      if (!inExtension()) {
        setStatus(NOT_IN_EXTENSION);
        return null;
      }
      try {
        const req: BackgroundRequest = { type: 'to-content', cmd };
        const result = (await chrome.runtime.sendMessage(req)) as BackgroundResult | undefined;
        if (!result) {
          setStatus({ connected: false, message: 'background が応答しません' });
          return null;
        }
        if (hasShortsState(result)) {
          cachedPlaying = result.state.playing;
          if (result.state.index !== cachedIndex) {
            cachedIndex = result.state.index;
            events.emit('state', { playing: cachedPlaying, index: cachedIndex });
          }
          setStatus({
            connected: true,
            message: 'Shorts に接続中',
            ...(result.state.strategy ? { strategy: result.state.strategy } : {}),
          });
        } else if (!result.ok) {
          cachedPlaying = false;
          setStatus({ connected: false, message: ERROR_JA[result.error] ?? result.error });
        }
        return result;
      } catch (err) {
        cachedPlaying = false;
        setStatus({ connected: false, message: `拡張の通信に失敗: ${String(err)}` });
        return null;
      }
    };
    const next = queue.then(run, run);
    queue = next;
    return next;
  }

  function onRuntimeMessage(message: unknown): void {
    if (!isNoticeEnvelope(message)) return;
    const { notice } = message;
    if (notice.type === 'user-nav') {
      events.emit('user-nav', { direction: notice.direction, blocked: notice.blocked });
    } else if (notice.type === 'shorts-left') {
      cachedPlaying = false;
      setStatus({ connected: false, message: 'Shorts から離れました' });
    } else if (notice.type === 'selector-failure') {
      setStatus({ connected: true, message: `⚠ ${notice.detail}` });
    }
  }

  return {
    kind: 'shorts-extension',
    events,

    async attach(): Promise<void> {
      if (!inExtension()) {
        setStatus(NOT_IN_EXTENSION);
        return;
      }
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      await send({ type: 'ping' });
      // 再生状態の同期。tick() が毎フレーム isPlaying() を見るのに対し、実体は
      // 別プロセスにあるので、ここで定期的に引き寄せる。
      pollTimer = window.setInterval(() => void send({ type: 'ping' }), pollIntervalMs);
    },

    async detach(): Promise<void> {
      if (inExtension()) chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = null;
    },

    async play(): Promise<void> {
      wantPlaying = true;
      await send({ type: 'play' });
    },

    async pause(reason): Promise<void> {
      wantPlaying = false;
      await send({ type: 'pause', reason });
    },

    setLocked(locked: boolean, reason?: string): void {
      // Slider インターフェース上は同期。キューに積んで fire-and-forget にする。
      void send(locked ? { type: 'lock', reason: reason ?? 'ロック中' } : { type: 'unlock' });
    },

    async next(_reason): Promise<void> {
      await send({ type: 'next' });
      // 送った先の動画は YouTube が autoplay しようとするが、content script の
      // ゲートが閉じていれば即座に止められる。再生したい場合は明示的に play する。
      if (wantPlaying) await send({ type: 'play' });
    },

    isPlaying(): boolean {
      return cachedPlaying;
    },

    status(): ShortsSliderStatus {
      return status;
    },

    async ensureShortsTab(): Promise<void> {
      if (!inExtension()) {
        setStatus(NOT_IN_EXTENSION);
        return;
      }
      try {
        const req: BackgroundRequest = { type: 'ensure-shorts-tab' };
        await chrome.runtime.sendMessage(req);
      } catch (err) {
        setStatus({ connected: false, message: `タブを開けませんでした: ${String(err)}` });
      }
      await send({ type: 'ping' });
    },
  };
}
