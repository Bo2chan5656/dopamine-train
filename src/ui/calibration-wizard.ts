import type { Calibration, CalibrationRejectReason, CalibrationSample } from '../core/detect/calibration';
import { validateCalibration } from '../core/detect/calibration';
import type { PoseSource } from '../sensors/pose/pose-source';
import type { ArmSide, CameraView, Ms, SignalKind } from '../core/types';
import './styles/calibration-wizard.css';

export interface CalibrationWizardOptions {
  readonly source: PoseSource;
  readonly signal: SignalKind;
  readonly side: ArmSide;
  readonly view: CameraView;
  /** 各ステップの記録時間。既定1秒。 */
  readonly windowMs?: Ms;
  readonly onComplete: (calibration: Calibration) => void;
}

type Step = 'intro' | 'bottom' | 'bottom-done' | 'top' | 'result';

const FAIL_REASON_JA: Record<CalibrationRejectReason, string> = {
  rom_too_small: '動きが小さすぎます。もっと大きく伸ばし切ってから、大きく巻き上げてください。',
  low_confidence: '体がよく見えていません。照明を明るくするか、カメラとの距離・角度を調整してください。',
  inverted: '上端と下端が逆になっているようです。もう一度、伸展→屈曲の順で試してください。',
};

function armSideLabel(side: ArmSide): string {
  return side === 'left' ? '左' : side === 'right' ? '右' : '両';
}

/**
 * 下端(伸展)→上端(屈曲)の2ステップ、各1秒記録。ここが実質的な「唯一の不正対策」
 * （calibration.ts の validateCalibration）の入り口 — 小さすぎる ROM や低信頼度の
 * 記録は弾いてやり直しを促す。
 */
export function createCalibrationWizard(root: HTMLElement, opts: CalibrationWizardOptions): void {
  // root（.dt-feed-area の子）自体を画面いっぱいのオーバーレイにする。
  root.className = 'dt-calibration-overlay';
  const windowMs = opts.windowMs ?? 1000;
  const container = document.createElement('div');
  container.className = 'dt-calibration-wizard';
  root.appendChild(container);

  let bottomSummary: CalibrationSample | null = null;
  let topSummary: CalibrationSample | null = null;

  function wireButtons(): void {
    container.querySelector('[data-action="start"]')?.addEventListener('click', () => void startBottom());
    container.querySelector('[data-action="record-top"]')?.addEventListener('click', () => void startTop());
    container.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      bottomSummary = null;
      topSummary = null;
      render('intro');
    });
  }

  function render(step: Step, failReason?: CalibrationRejectReason): void {
    switch (step) {
      case 'intro':
        container.innerHTML = `
          <h2>キャリブレーション</h2>
          <p>${armSideLabel(opts.side)}腕で、下端（伸展）と上端（屈曲）を1秒ずつ記録します。</p>
          <button data-action="start">開始</button>
        `;
        break;
      case 'bottom':
        container.innerHTML = `<p>腕を完全に伸ばしてください…（記録中）</p>`;
        break;
      case 'bottom-done':
        container.innerHTML = `
          <p>下端を記録しました。次は上端です。</p>
          <button data-action="record-top">腕を巻き上げて記録開始</button>
        `;
        break;
      case 'top':
        container.innerHTML = `<p>腕を完全に巻き上げてください…（記録中）</p>`;
        break;
      case 'result':
        container.innerHTML = failReason
          ? `<p class="dt-calibration-wizard__error">キャリブレーションに失敗しました: ${FAIL_REASON_JA[failReason]}</p>
             <button data-action="retry">最初からやり直す</button>`
          : `<p class="dt-calibration-wizard__success">キャリブレーション完了！</p>`;
        break;
    }
    wireButtons();
  }

  async function startBottom(): Promise<void> {
    render('bottom');
    bottomSummary = await opts.source.sample(windowMs);
    render('bottom-done');
  }

  async function startTop(): Promise<void> {
    render('top');
    topSummary = await opts.source.sample(windowMs);
    finish();
  }

  function finish(): void {
    if (!bottomSummary || !topSummary) return; // 起こらないはずの型ガード
    const calibration: Calibration = {
      signal: opts.signal,
      side: opts.side,
      view: opts.view,
      bottomRaw: bottomSummary.p50,
      topRaw: topSummary.p50,
      armLenPx: opts.source.currentArmLengthPx() ?? 0,
      createdAt: Date.now(),
    };
    const validation = validateCalibration(calibration, { bottom: bottomSummary, top: topSummary });
    if (validation.ok) {
      render('result');
      opts.onComplete(calibration);
    } else {
      render('result', validation.reason);
    }
  }

  render('intro');
}
