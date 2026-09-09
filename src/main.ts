import type { Calibration } from './core/detect/calibration';
import { createLedger } from './core/credit/ledger';
import type { CreditPolicy } from './core/credit/policy';
import { SessionController, type Settings } from './core/session/controller';
import { createLibrary } from './player/library';
import { createPoseSource } from './sensors/pose/pose-source';
import { createLocalPlayerSlider } from './slider/local-player-slider';
import { loadLedgerSnapshot, loadSettings, saveLedgerSnapshot, saveSettings } from './storage/local';
import { createCalibrationWizard } from './ui/calibration-wizard';
import { createCameraPreview } from './ui/camera-preview';
import { createDevPanel } from './ui/dev-panel';
import { createHud } from './ui/hud';
import { createSettingsPanel } from './ui/settings-panel';
import { createSound } from './ui/sound';
import './ui/styles/layout.css';

// M4 で実機未確認のため仮決め（README の M4 セクション参照）。信号は
// SignalExtractor で差し替え可能な設計なので、実機で比較した結果に応じて
// ここを変えるだけで済む。
const SIGNAL_KIND = 'elbow-angle' as const;
const ARM_SIDE = 'right' as const;
const CAMERA_VIEW = 'side45' as const;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('main: #app not found');
app.innerHTML = ''; // M0 のプレースホルダーを消す
app.className = 'dt-app-shell';

const topbar = document.createElement('div');
topbar.className = 'dt-topbar';
const feedArea = document.createElement('div');
feedArea.className = 'dt-feed-area';
app.append(topbar, feedArea);

let settings: Settings = loadSettings();
let ledger = createLedger(settings.credit, loadLedgerSnapshot());

const source = createPoseSource({ side: ARM_SIDE });
const slider = createLocalPlayerSlider(feedArea);
const hud = createHud(feedArea); // フィードの上に重なるオーバーレイ（hud.css で position:absolute）
const sound = createSound();
const clock = { wall: () => Date.now() };

createLibrary(topbar, (items) => slider.setItems(items));

const preview = createCameraPreview(topbar);
const devPanel = createDevPanel(topbar);
source.events.on('progress', ({ value, at }) => devPanel.pushSignal(value, at));
source.events.on('tracking', (state) => devPanel.updateTracking(state));
source.events.on('diag', (diag) => devPanel.updateDiag(diag));

let controller = new SessionController({ source, ledger, slider, hud, sound, settings, clock });

createSettingsPanel(topbar, {
  initial: settings.credit,
  onChange(policy: CreditPolicy) {
    settings = { credit: policy };
    saveSettings(settings);
    // 進行中の残高/累計はスナップショット経由でそのまま新しい policy に引き継ぐ。
    // controller.stop() は購読解除のみ行い、source（カメラ）は動かし続ける。
    controller.stop();
    ledger = createLedger(policy, ledger.toJSON());
    controller = new SessionController({ source, ledger, slider, hud, sound, settings, clock });
    controller.start();
  },
});

/** キャリブレーション完了後にだけ、レップ判定 + 永続化の rAF ループを開始する。 */
function startRunLoop(): void {
  controller.start();
  let lastSaveAtWall = 0;
  function loop(now: number): void {
    controller.tick(now, !document.hidden);
    const wallNow = clock.wall();
    if (wallNow - lastSaveAtWall > 1000) {
      saveLedgerSnapshot(ledger.toJSON());
      lastSaveAtWall = wallNow;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

await source.init(); // カメラ許可 + モデルロード + フレームポンプ開始（レップ判定はまだ無効）
await slider.attach(); // フィードを DOM にマウントしてから始める（play() が効くようにする）
preview.attachVideo(source.videoElement());

function drawSkeletonLoop(): void {
  const kp = source.lastKeypoints();
  if (kp) preview.drawSkeleton(kp);
  requestAnimationFrame(drawSkeletonLoop);
}
requestAnimationFrame(drawSkeletonLoop);

const calibrationRoot = document.createElement('div');
feedArea.appendChild(calibrationRoot);
createCalibrationWizard(calibrationRoot, {
  source,
  signal: SIGNAL_KIND,
  side: ARM_SIDE,
  view: CAMERA_VIEW,
  onComplete(calibration: Calibration) {
    source.reconfigure({ calibration, side: ARM_SIDE });
    calibrationRoot.remove();
    startRunLoop();
  },
});
