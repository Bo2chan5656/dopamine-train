import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { assertPatternsConsistent, manifest } from './extension/manifest.config';

/**
 * 拡張のビルド その1: トレーナーページ（ESM）+ background service worker（ESM）+ manifest。
 *
 * content script は ES module が使えないため別ビルド（vite.config.content.ts）に
 * 分けてある。`npm run build:ext` が両方を順に走らせる（こちらが emptyOutDir:true
 * で先、あちらが emptyOutDir:false で後）。
 *
 * ★ @crxjs/vite-plugin は使っていない。やってくれるのは manifest の生成と
 * content script の HMR だが、manifest は下の30行のプラグインで足り、
 * content script は結局 YouTube の実ページでしか検証できない（HMR の恩恵が薄い）。
 * 依存を1つ増やしてバージョン追従のリスクを負う理由が無いと判断した。
 */

function emitManifest(): Plugin {
  return {
    name: 'dt-emit-manifest',
    buildStart() {
      assertPatternsConsistent();
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./extension', import.meta.url)),
  // MoveNet の self-host モデル（public/models/）をそのまま拡張に同梱する。
  // 拡張ページからは同一オリジンなので web_accessible_resources は不要。
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  plugins: [emitManifest()],

  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      // src/ 側と同じ理由（pose-detection が全モデルの detector を無条件に
      // require する）。詳細は src/stubs/empty-module.ts。
      '@mediapipe/pose': fileURLToPath(new URL('./src/stubs/empty-module.ts', import.meta.url)),
      '@tensorflow/tfjs-backend-webgpu': fileURLToPath(new URL('./src/stubs/empty-module.ts', import.meta.url)),
    },
  },

  build: {
    outDir: fileURLToPath(new URL('./dist-extension', import.meta.url)),
    emptyOutDir: true,
    // trainer.ts はトップレベル await を使う。
    target: 'esnext',
    rollupOptions: {
      input: {
        trainer: fileURLToPath(new URL('./extension/trainer.html', import.meta.url)),
        background: fileURLToPath(new URL('./extension/background.ts', import.meta.url)),
      },
      output: {
        // manifest の service_worker は 'background.js' 固定なので、ハッシュを付けない。
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
