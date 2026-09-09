import type { BackgroundRequest, BackgroundResult, ContentCommand, ContentResult } from './protocol';
import { SHORTS_HOME_URL, SHORTS_URL_PATTERNS } from './protocol';

/**
 * トレーナーページと content script の仲介。担うのは2つだけ:
 *   1. トレーナーウィンドウを開く / 前面に出す
 *   2. 「どの YouTube タブに送るか」の解決とメッセージの転送
 *
 * ★ MV3 の service worker は数十秒アイドルすると破棄される。したがって
 * **状態をモジュール変数に持たない**（tabId をキャッシュすると次の起動で消えて
 * 「なぜか動かない」になる）。タブは毎回 chrome.tabs.query で引き直し、
 * トレーナーウィンドウの id だけは chrome.storage.session に置く。
 *
 * ★ カメラ許可のプロンプトは offscreen / popup（action の popup）/ side panel
 * からは出せない（Chrome の long standing bug: crbug 1214847 / 1339382）。
 * そのため windows.create({type:'popup'}) で「独立ウィンドウとして開く通常の
 * 拡張ページ」にする必要がある — ここは変更しないこと。
 */

const TRAINER_URL = 'trainer.html';
const TRAINER_WINDOW_KEY = 'trainerWindowId';

chrome.action.onClicked.addListener(() => {
  void openTrainerWindow();
});

async function openTrainerWindow(): Promise<void> {
  const stored = await chrome.storage.session.get(TRAINER_WINDOW_KEY);
  const existingId = stored[TRAINER_WINDOW_KEY];

  if (typeof existingId === 'number') {
    try {
      await chrome.windows.update(existingId, { focused: true });
      return;
    } catch {
      // 閉じられている。作り直す。
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(TRAINER_URL),
    type: 'popup',
    width: 560,
    height: 900,
  });
  if (win?.id !== undefined) {
    await chrome.storage.session.set({ [TRAINER_WINDOW_KEY]: win.id });
  }
}

/**
 * 送信先の YouTube タブ。複数開いている場合はアクティブなもの、次に最後に
 * 触られたものを選ぶ。
 */
async function resolveShortsTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: [...SHORTS_URL_PATTERNS] });
  if (tabs.length === 0) return null;
  const active = tabs.find((t) => t.active);
  if (active) return active;
  return [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0] ?? null;
}

/**
 * content script へ転送する。拡張をリロードしたのにページを再読込していない場合、
 * 古い content script は死んでいて sendMessage が reject する — その場合は
 * scripting.executeScript で注入し直して1回だけリトライする
 * （「拡張を更新したら動かなくなった。ページを手動でリロードしろ」を無くすため）。
 */
async function forwardToContent(tabId: number, cmd: ContentCommand): Promise<BackgroundResult> {
  try {
    return (await chrome.tabs.sendMessage(tabId, cmd)) as ContentResult;
  } catch (first) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return (await chrome.tabs.sendMessage(tabId, cmd)) as ContentResult;
    } catch (second) {
      return {
        ok: false,
        error: 'no_content_script',
        detail: `${String(first)} / 再注入も失敗: ${String(second)}`,
      };
    }
  }
}

async function handle(req: BackgroundRequest): Promise<BackgroundResult> {
  switch (req.type) {
    case 'ensure-shorts-tab': {
      const tab = await resolveShortsTab();
      if (tab?.id !== undefined) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true, action: 'focused' };
      }
      await chrome.tabs.create({ url: SHORTS_HOME_URL, active: true });
      return { ok: true, action: 'created' };
    }

    case 'to-content': {
      const tab = await resolveShortsTab();
      if (tab?.id === undefined) {
        return { ok: false, error: 'no_tab', detail: 'youtube.com/shorts のタブが開いていません' };
      }
      return forwardToContent(tab.id, req.cmd);
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isBackgroundRequest(message)) return false; // notice 等は素通り（trainer が直接受ける）
  handle(message).then(sendResponse, (err: unknown) => {
    sendResponse({ ok: false, error: 'no_tab', detail: String(err) } satisfies BackgroundResult);
  });
  return true;
});

function isBackgroundRequest(v: unknown): v is BackgroundRequest {
  if (typeof v !== 'object' || v === null) return false;
  const type = (v as { type?: unknown }).type;
  return type === 'to-content' || type === 'ensure-shorts-tab';
}
