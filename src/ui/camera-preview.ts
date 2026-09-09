import './styles/camera-preview.css';

export interface PreviewKeypoint {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

export interface CameraPreview {
  attachVideo(video: HTMLVideoElement): void;
  drawSkeleton(keypoints: readonly PreviewKeypoint[]): void;
}

// 骨格の接続線（COCO index）。肩-肘-手首と肩-肩だけで、カール判定に関係する
// 部位が見えているかどうかを一目で確認できれば十分（全身の骨格線は不要）。
const BONES: ReadonlyArray<readonly [number, number]> = [
  [5, 7],
  [7, 9], // 左肩-肘-手首
  [6, 8],
  [8, 10], // 右肩-肘-手首
  [5, 6], // 肩-肩
];
const MIN_DRAW_SCORE = 0.3;

/**
 * カメラ映像 + 骨格オーバーレイ。video と canvas の両方に scaleX(-1) を CSS で
 * 掛けて鏡像表示にする — キーポイントは生座標のまま描画してよい（両方に同じ
 * 変換が掛かっているので座標系が一致する）。
 */
export function createCameraPreview(root: HTMLElement): CameraPreview {
  const container = document.createElement('div');
  container.className = 'dt-camera-preview';
  const canvas = document.createElement('canvas');
  canvas.className = 'dt-camera-preview__overlay';
  container.appendChild(canvas);
  root.appendChild(container);

  const ctx = canvas.getContext('2d');
  let video: HTMLVideoElement | null = null;

  function drawBone(keypoints: readonly PreviewKeypoint[], aIdx: number, bIdx: number): void {
    if (!ctx) return;
    const a = keypoints[aIdx];
    const b = keypoints[bIdx];
    if (!a || !b || a.score < MIN_DRAW_SCORE || b.score < MIN_DRAW_SCORE) return;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  return {
    attachVideo(v: HTMLVideoElement): void {
      video = v;
      video.className = 'dt-camera-preview__video';
      container.insertBefore(video, canvas);
    },

    drawSkeleton(keypoints: readonly PreviewKeypoint[]): void {
      if (!ctx || !video) return;
      const w = video.videoWidth || 640;
      const h = video.videoHeight || 360;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      for (const [a, b] of BONES) drawBone(keypoints, a, b);

      for (const kp of keypoints) {
        if (kp.score < MIN_DRAW_SCORE) continue;
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = kp.score > 0.6 ? '#4ade80' : '#fbbf24';
        ctx.fill();
      }
    },
  };
}
