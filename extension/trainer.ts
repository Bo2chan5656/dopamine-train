import { createLedger } from '../src/core/credit/ledger';
import { perSlidePreset, type CreditPolicy } from '../src/core/credit/policy';
import type { Calibration } from '../src/core/detect/calibration';
import { SessionController, type Settings } from '../src/core/session/controller';
import { createKeyboardSource } from '../src/sensors/keyboard-source';
import { DEFAULT_DETECTOR_CONFIG } from '../src/core/detect/rep-detector';
import { createPoseSource } from '../src/sensors/pose/pose-source';
import {
  hasSavedSettings,
  loadLedgerSnapshot,
  loadSettings,
  saveLedgerSnapshot,
  saveSettings,
} from '../src/storage/local';
import { createCalibrationWizard } from '../src/ui/calibration-wizard';
import { createCameraPreview } from '../src/ui/camera-preview';
import { createDevPanel } from '../src/ui/dev-panel';
import { createHud } from '../src/ui/hud';
import { createSettingsPanel } from '../src/ui/settings-panel';
import { createSound } from '../src/ui/sound';
import { createShortsExtensionSlider } from './shorts-extension-slider';
import { createConnectionBar } from './ui/connection-bar';
import '../src/ui/styles/layout.css';
import './trainer.css';

/**
 * トレーナーウィンドウ。アプリの唯一のエントリポイントで、RepSource / CreditLedger /
 * Slider / HUD を結線する。Slider の実体は YouTube Shorts（別ウィンドウの
 * content script 越し）。
 *
 * ★ ここは「独立ウィンドウとして開かれた通常の拡張ページ」でなければならない。
 * offscreen / action popup / side panel からはカメラ許可プロンプトが出せない
 * （crbug 1214847 / 1339382）。background.ts の windows.create({type:'popup'}) を
 * 変えないこと。
 *
 * ★ core/ は1行も変更せずにこの構成が成立している（controller.ts に足したのは
 * per-slide 分岐と maxTickDtMs だけで、どちらも DOM/chrome.* に依存しない）。
 */

/**
 * 使う信号。★実機の計測結果に基づき elbow-angle を採用（M4 で保留していた判断）。
 *
 * 実機のキャリブレーションで得られた値:
 *   ROM 156.83°（下端 175.60° → 上端 18.77°）／ 信頼度 p10 = 0.43-0.45
 *   推定した向き = 斜め45度（肩幅/上腕長 = 0.85）／ 欠測フレーム 0
 * フルレンジのカールがそのまま素直な角度変化として出ており、信号として理想的。
 *
 * 一度 wrist-height に切り替えたが、それは「体が正面を向いている」という前提での
 * 判断だった。肩幅/上腕長 の実測が 0.85（=斜め45度）だったため前提が誤りで、
 * elbow-angle が退化する条件（正面向き）には該当していなかった。
 *
 * ★ ただし elbow-angle は正面向きだと原理的に退化する（前腕がカメラに向かって
 * 振り上がり、画像上で肩・肘・手首が一直線に潰れる）。立ち位置を変えて正面向きに
 * なる場合は 'wrist-height' に切り替えること。あちらは (肩y − 手首y)/上腕長 なので
 * 正面でも退化しないが、肩の上下動（すくめる・傾く）の影響を受ける。
 * SignalExtractor で差し替え可能な設計なので、この1行を変えるだけで切り替わる。
 *
 * ★ 腕の左右とカメラの向きはもう宣言しない。キャリブレーションが両腕を同時に
 * 観測して「実際に動かした腕」を選び、体の向きも肩幅/上腕長から推定する
 * （calibration.ts の resolveCalibration）。
 */
const SIGNAL_KIND = 'elbow-angle' as const;
/** キャリブレーション前の暫定値。この間 detector は無効なので実質使われない。 */
const INITIAL_ARM_SIDE = 'right' as const;

/**
 * ★ tick の駆動を rAF ではなく setInterval にしている。トレーナーウィンドウは
 * YouTube のウィンドウに覆われて非可視/非フォーカスになるのが「通常の使い方」で、
 * その状態では Chrome が rAF を止めてしまう — rAF で駆動するとクレジットが
 * 一切減らず無限に視聴できてしまう。setInterval は絞られても最低1秒間隔で走るので、
 * maxTickDtMs を 2000 にして取りこぼさないようにする。
 */
const TICK_INTERVAL_MS = 250;
const MAX_TICK_DT_MS = 2000;

const params = new URLSearchParams(location.search);
/** `trainer.html?source=keyboard` でカメラを使わずに j/k キーで検証できる。 */
const useKeyboard = params.get('source') === 'keyboard';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('trainer: #app not found');
app.className = 'dt-app-shell';

const topbar = document.createElement('div');
topbar.className = 'dt-topbar';
const feedArea = document.createElement('div');
feedArea.className = 'dt-feed-area';
app.append(topbar, feedArea);

// 拡張の初回起動時だけ per-slide（1レップ1スライド）で始める。localStorage は
// chrome-extension:// のオリジンに紐づくので、`npm run dev` の localhost で開いた
// ときの設定とは独立している（同じページでも残高・設定は別勘定になる）。
let settings: Settings = hasSavedSettings() ? loadSettings() : { credit: perSlidePreset() };
let ledger = createLedger(settings.credit, loadLedgerSnapshot());

const connectionBar = createConnectionBar(topbar, {
  // slider はこの下で宣言される。クリック時にしか評価されないので前方参照でよい。
  onOpenShorts: () => void slider.ensureShortsTab(),
});
const slider = createShortsExtensionSlider({
  onStatus: (status) => connectionBar.update(status),
});

const note = document.createElement('div');
note.className = 'dt-trainer-note';
note.innerHTML = useKeyboard
  ? `<b>キーボードモード</b>（カメラなし）: <code>j</code> = 有効レップ / <code>k</code> = 無効レップ。
     このウィンドウにフォーカスした状態でキーを押してください。`
  : `<b>カメラモード</b>: キャリブレーション後にレップ判定が始まります。
     カメラなしで動作確認する場合は URL に <code>?source=keyboard</code> を付けてください。`;
topbar.appendChild(note);

// null 合体で分岐させ、後段でのキャストを避ける（PoseSource 固有のメソッドを
// 使うのはカメラモードだけなので、型ごと分けて持つ）。
const poseSource = useKeyboard ? null : createPoseSource({ side: INITIAL_ARM_SIDE });
const source = poseSource ?? createKeyboardSource();

const hud = createHud(feedArea);
const sound = createSound();
const clock = { wall: () => Date.now() };

function buildController(): SessionController {
  return new SessionController({
    source,
    ledger,
    slider,
    hud,
    sound,
    settings,
    clock,
    maxTickDtMs: MAX_TICK_DT_MS,
  });
}

let controller = buildController();

/**
 * ★ キャリブレーション完了前に controller.start() を呼んではいけない。
 * start() は source.start() を呼び、pose-source の detectorEnabled を立てるため、
 * 仮の DEFAULT_CALIBRATION のままレップを数え始めてしまう（＝キャリブレーション中に
 * 設定を触ると、いい加減な閾値で Shorts が送られ始める）。
 */
let runLoopStarted = false;

createSettingsPanel(topbar, {
  initial: settings.credit,
  onChange(policy: CreditPolicy) {
    settings = { credit: policy };
    saveSettings(settings);
    // stop() は購読解除のみ。source（カメラ）と slider（Shorts への接続）は
    // そのまま動かし続ける。
    controller.stop();
    ledger = createLedger(policy, ledger.toJSON());
    controller = buildController();
    if (runLoopStarted) controller.start();
  },
});

/** キャリブレーション完了後（キーボードモードでは即座に）レップ判定を開始する。 */
function startRunLoop(): void {
  runLoopStarted = true;
  controller.start();
  let lastSaveAtWall = 0;
  window.setInterval(() => {
    // ★ isVisible には常に true を渡す。このウィンドウの可視性は意味を持たない —
    // 再生は別ウィンドウの YouTube で起きており、実際に再生中かどうかは
    // slider.isPlaying()（content script が報告する <video>.paused の実状態）が
    // 権威ある情報源になる。ここで document.hidden を見てしまうと
    // 「YouTube を前面にした瞬間にクレジットが減らなくなる」という逆の抜け穴になる。
    controller.tick(performance.now(), true);
    const wallNow = clock.wall();
    if (wallNow - lastSaveAtWall > 1000) {
      saveLedgerSnapshot(ledger.toJSON());
      lastSaveAtWall = wallNow;
    }
  }, TICK_INTERVAL_MS);
}

await slider.attach();
await source.init();

if (!poseSource) {
  startRunLoop();
} else {
  const preview = createCameraPreview(topbar);
  const devPanel = createDevPanel(topbar);
  devPanel.setThresholds(DEFAULT_DETECTOR_CONFIG.bottomThreshold, DEFAULT_DETECTOR_CONFIG.topThreshold);
  devPanel.setWarnScore(DEFAULT_DETECTOR_CONFIG.warnScore);
  poseSource.events.on('progress', ({ value, at }) => devPanel.pushSignal(value, at));
  poseSource.events.on('tracking', (state) => devPanel.updateTracking(state));
  poseSource.events.on('diag', (diag) => devPanel.updateDiag(diag));
  preview.attachVideo(poseSource.videoElement());

  const drawSkeletonLoop = (): void => {
    const kp = poseSource.lastKeypoints();
    if (kp) preview.drawSkeleton(kp);
    requestAnimationFrame(drawSkeletonLoop);
  };
  requestAnimationFrame(drawSkeletonLoop);

  const calibrationRoot = document.createElement('div');
  feedArea.appendChild(calibrationRoot);
  createCalibrationWizard(calibrationRoot, {
    source: poseSource,
    signal: SIGNAL_KIND,
    onComplete(calibration: Calibration) {
      // ★ side は宣言ではなくキャリブレーションが選んだ結果を使う。
      poseSource.reconfigure({ calibration, side: calibration.side });
      calibrationRoot.remove();
      startRunLoop();
    },
  });
}
