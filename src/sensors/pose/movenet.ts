import * as poseDetection from '@tensorflow-models/pose-detection';
import * as tf from '@tensorflow/tfjs-core';
// 副作用 import: バックエンドを登録する。必須（無いと createDetector が失敗する）。
import '@tensorflow/tfjs-backend-webgl';
import type { PixelKeypoint } from './keypoints';
import { toPixelKeypoints } from './keypoints';

const MODEL_URL = '/models/movenet-lightning-v4/model.json';

export interface MoveNetPose {
  readonly keypoints: readonly PixelKeypoint[]; // 17件、COCO順、ピクセル座標
}

export interface MoveNetHandle {
  /**
   * video を直接渡すこと（canvas 経由だと timestamp が undefined になり平滑化が
   * 壊れる、という MoveNet 公式 README の注記があるが、enableSmoothing は false に
   * しているのでここでは実害はない。ただし video を渡す設計は変えない — 将来
   * enableSmoothing を見直すことがあっても安全なままにするため）。
   */
  estimate(video: HTMLVideoElement, timestampMs: number): Promise<MoveNetPose | null>;
  dispose(): void;
}

/**
 * MoveNet SinglePose.Lightning を self-host したモデルからロードする。
 * enableSmoothing は明示的に false — MoveNet 内蔵の One-Euro（ピクセル単位、
 * minCutOff:2.5/beta:300）と、core/filter/one-euro.ts の正規化スカラ向けの
 * One-Euro が二重にかかるのを避けるため（設計判断は plan 参照）。
 */
export async function loadMoveNet(): Promise<MoveNetHandle> {
  await tf.setBackend('webgl');
  await tf.ready();

  const detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    enableSmoothing: false,
    // ★ 0.3 → 0.2。これを下回ると estimatePoses が姿勢を1つも返さず、
    // pose-source 側で score:0 のダミーになって tracking-lost に近づく。
    // MoveNet 内部の既定は DEFAULT_MIN_POSE_SCORE=0.25 なので、
    // 0.2 はそれより緩い＝取りこぼしを最小にする設定。
    minPoseScore: 0.2,
    modelUrl: MODEL_URL,
  });

  // ウォームアップ: 初回推論はシェーダコンパイル等で目立って遅い。ダミーフレームで
  // 先に済ませておき、実際のカメラフレームの最初の1枚からレイテンシを安定させる。
  const warmupCanvas = document.createElement('canvas');
  warmupCanvas.width = 192;
  warmupCanvas.height = 192;
  await detector.estimatePoses(warmupCanvas, {}, 0);

  return {
    async estimate(video, timestampMs) {
      const poses = await detector.estimatePoses(video, {}, timestampMs);
      const pose = poses[0];
      if (!pose) return null;
      return { keypoints: toPixelKeypoints(pose.keypoints) };
    },
    dispose() {
      detector.dispose();
    },
  };
}
