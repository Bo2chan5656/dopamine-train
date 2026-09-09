import { SHORTS_URL_PATTERNS } from './protocol';

/**
 * MV3 manifest。JSON ファイルではなく TS オブジェクトにしてある — URL の match
 * パターンを protocol.ts と共有できる（manifest と chrome.tabs.query の対象が
 * 食い違うと「content script は動いているのに background がタブを見つけられない」
 * という切り分けにくいバグになる）。vite.config.extension.ts が
 * dist-extension/manifest.json として書き出す。
 */

/** youtube.com 全体に注入する。Shorts は SPA なので、ホームから遷移した場合に
 * /shorts/* だけの match ではスクリプトが読み込まれない（ページロードが起きない）。
 * content script 側は isOnShorts() で自身を無効化する。 */
const YOUTUBE_MATCHES = ['*://www.youtube.com/*', '*://m.youtube.com/*'];

export const manifest = {
  manifest_version: 3,
  name: 'Dopamine Train',
  version: '0.1.0',
  description: 'ダンベルのレップをこなさないと YouTube Shorts を送れなくする',

  // tabs: Shorts のタブを探す / 前面に出す
  // storage: トレーナーウィンドウの id を chrome.storage.session に置く
  // scripting: 拡張の更新直後に content script を再注入してリトライする
  permissions: ['tabs', 'storage', 'scripting'],
  host_permissions: YOUTUBE_MATCHES,

  background: {
    service_worker: 'background.js',
    type: 'module',
  },

  // default_popup を置かない = ツールバーのクリックが chrome.action.onClicked に来る。
  // ★ popup にトレーナーを入れてはいけない（カメラ許可プロンプトが出せない）。
  action: {
    default_title: 'Dopamine Train のトレーナーを開く',
  },

  content_scripts: [
    {
      matches: YOUTUBE_MATCHES,
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],

  // ★ content_security_policy は意図的に指定しない。TF.js + WebGL は MV3 の
  // デフォルト CSP のまま動く（tfjs-core / converter / backend-webgl /
  // pose-detection の全バンドルに eval( と new Function( が0件であることを確認済み）。
  // MediaPipe を選んでいたら 'wasm-unsafe-eval' の緩和が必要だった。
} as const;

/** background.ts が使う match パターンと manifest の host_permissions が一致していることの確認。 */
export function assertPatternsConsistent(): void {
  for (const pattern of SHORTS_URL_PATTERNS) {
    const host = pattern.replace('*://', '').split('/')[0];
    if (!YOUTUBE_MATCHES.some((m) => m.includes(host ?? ''))) {
      throw new Error(`manifest: host_permissions が ${pattern} をカバーしていない`);
    }
  }
}
