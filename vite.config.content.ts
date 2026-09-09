import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * 拡張のビルド その2: content script。
 *
 * ★ MV3 の `content_scripts` は ES module を読み込めない（`type: "module"` に
 * 相当する指定が無い）。したがってコード分割なしの単一 IIFE に固める必要がある —
 * これが vite.config.extension.ts と分けている唯一の理由。lib モードの
 * formats:['iife'] は inlineDynamicImports が自動で有効になり、import が一切
 * 残らないバンドルを吐く。
 *
 * ★ emptyOutDir: false。vite.config.extension.ts が先に走って dist-extension を
 * 作るので、こちらで消してはいけない。
 */
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./dist-extension', import.meta.url)),
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: fileURLToPath(new URL('./extension/content/shorts.ts', import.meta.url)),
      formats: ['iife'],
      name: 'DopamineTrainContent',
      fileName: () => 'content.js',
    },
  },
});
