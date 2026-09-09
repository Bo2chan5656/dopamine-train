import { createPoseSource } from './src/sensors/pose/pose-source';
import { createCameraPreview } from './src/ui/camera-preview';
import { createDevPanel } from './src/ui/dev-panel';

const app = document.querySelector<HTMLDivElement>('#app')!;

const statusEl = document.createElement('div');
statusEl.id = 'status';
statusEl.style.color = '#f5f5f5';
statusEl.style.fontFamily = 'monospace';
statusEl.textContent = 'initializing...';
app.appendChild(statusEl);

const previewRoot = document.createElement('div');
const panelRoot = document.createElement('div');
app.append(previewRoot, panelRoot);

const preview = createCameraPreview(previewRoot);
const devPanel = createDevPanel(panelRoot);

const source = createPoseSource({ side: 'right' });

source.events.on('progress', ({ value, at }) => {
  devPanel.pushSignal(value, at);
});
source.events.on('tracking', (state) => {
  devPanel.updateTracking(state);
});
source.events.on('diag', (diag) => {
  devPanel.updateDiag(diag);
});
source.events.on('rep', (rep) => {
  console.log('rep', rep);
});

function drawLoop(): void {
  const kp = source.lastKeypoints();
  if (kp) preview.drawSkeleton(kp);
  requestAnimationFrame(drawLoop);
}

try {
  await source.init();
  preview.attachVideo(source.videoElement());
  statusEl.textContent = 'init ok';
  source.start();
  statusEl.textContent = 'started';
  requestAnimationFrame(drawLoop);
} catch (err) {
  statusEl.textContent = `init failed: ${String(err)}`;
  console.error(err);
}
