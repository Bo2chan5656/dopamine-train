// @mediapipe/pose と @tensorflow/tfjs-backend-webgpu への未使用な静的依存を
// 解決するためのダミースタブ。
//
// @tensorflow-models/pose-detection 2.1.3 の create_detector.js は、実際に
// どのモデルを使うかに関わらず、全モデル種別（BlazePose/PoseNet/MoveNet）の
// detector モジュールを無条件に require するバレルインポート構造になっている。
// そのため MoveNet だけを使うつもりでも、ビルド（Vite の esbuild 依存事前
// バンドル）の静的依存解決の段階で @mediapipe/pose（約50MB）と
// tfjs-backend-webgpu が「解決できないモジュール」としてエラーになる。
//
// 実際の呼び出しコード（blazepose_mediapipe/detector.ts の
// `new pose.Pose(...)`、posenet/ops/*_webgpu.ts の `tfwebgpu.xxx`）は、いずれも
// BlazePoseMediaPipeDetector / PoseNet-WebGPU を実際にインスタンス化・実行
// する時にのみ評価される（モジュールのトップレベルスコープでは参照されない）。
// MoveNet のみを使う限りそのコードパスは実行されないため、このダミー
// スタブに差し替えても安全（vite.config.ts の resolve.alias 参照）。
export const Pose = class {}; // @mediapipe/pose が要求する named export
export const WebGPUBackend = class {}; // @tensorflow/tfjs-backend-webgpu (ESM) が要求する named export
export const webgpu_util = {}; // 同上
export default { Pose, WebGPUBackend, webgpu_util };
