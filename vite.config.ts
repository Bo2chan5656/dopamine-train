import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      // @tensorflow-models/pose-detection の create_detector.js が MoveNet 以外の
      // モデル（BlazePose/PoseNet）の detector も無条件に require するため、
      // 未インストールの @mediapipe/pose（約50MB）と tfjs-backend-webgpu への
      // 依存がビルド時に解決できずエラーになる。詳細は src/stubs/empty-module.ts。
      '@mediapipe/pose': fileURLToPath(new URL('./src/stubs/empty-module.ts', import.meta.url)),
      '@tensorflow/tfjs-backend-webgpu': fileURLToPath(new URL('./src/stubs/empty-module.ts', import.meta.url)),
    },
  },
  server: {
    // http://localhost:5173 は secure context なので getUserMedia がそのまま動く。
    // --host で LAN IP 経由にすると navigator.mediaDevices が undefined になるので使わない。
    port: 5173,
    strictPort: true,
  },
  test: {
    // core/ は DOM 依存ゼロなので jsdom は不要。
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
