import type {
  ArmCandidate,
  ArmCapture,
  Calibration,
  CalibrationDiagnostics,
  CalibrationRejectReason,
  JointDiagnosticRow,
} from '../core/detect/calibration';
import { resolveCalibration } from '../core/detect/calibration';
import { probeFrame, type JointName } from '../core/detect/signal';
import type { PoseSource } from '../sensors/pose/pose-source';
import type { CameraView, Ms, SignalKind } from '../core/types';
import './styles/calibration-wizard.css';

export interface CalibrationWizardOptions {
  readonly source: PoseSource;
  readonly signal: SignalKind;
  /** 各ステップの記録時間。既定1秒。 */
  readonly windowMs?: Ms;
  /** 記録開始前のカウントダウン。既定4秒（理由は COUNTDOWN_MS のコメント参照）。 */
  readonly countdownMs?: Ms;
  readonly onComplete: (calibration: Calibration) => void;
}

type Which = 'bottom' | 'top';
type Step =
  | { readonly kind: 'intro' }
  | { readonly kind: 'countdown'; readonly which: Which; readonly remainMs: Ms }
  | { readonly kind: 'recording'; readonly which: Which }
  | { readonly kind: 'bottom-done' }
  | { readonly kind: 'result'; readonly failure?: { reason: CalibrationRejectReason; diagnostics: CalibrationDiagnostics } };

/**
 * ★ 記録開始前のカウントダウン。これが無いと使えない。
 *
 * 以前はボタンを押した**瞬間**に1秒の記録が始まっていた。ボタンを押すには
 * トラックパッドやキーボードに手を伸ばす必要があるので、記録されるのは
 * 「腕を伸ばした姿勢」ではなく「PCに手を伸ばした姿勢」になる。その結果
 * 「伸ばす→曲げるの順で撮っているのに inverted（逆）と言われる」という、
 * ユーザーからはまったく理由が分からない症状になっていた（実際に報告された）。
 *
 * 4秒あれば、押してから元の位置に戻って構えられる。
 */
const COUNTDOWN_MS = 4000;
const COUNTDOWN_TICK_MS = 100;

const FAIL_REASON_JA: Record<CalibrationRejectReason, string> = {
  no_frames: 'カメラに体が映っていません。カメラの向きと、画面に写っているかを確認してください。',
  rom_too_small:
    '動きが小さすぎます。腕を伸ばし切ってから、大きく巻き上げてください（下の実測値で左右どちらが動いているか確認できます）。',
  low_confidence:
    '肩・肘・手首がはっきり見えていません。頭から膝まで画面に入るよう下がる / 照明を明るくする / 画面の中央に立つ、を試してください。',
  inverted:
    '上端と下端が逆になっています。1回目は「腕を下ろして伸ばした状態」、2回目は「巻き上げた状態」です。カウントダウン中に構え直してください。',
};

const VIEW_JA: Record<CameraView, string> = {
  front: '正面',
  side45: '斜め45度',
  side: 'ほぼ真横',
};

const JOINT_JA: Record<JointName, string> = { shoulder: '肩', elbow: '肘', wrist: '手首' };
const JOINT_LABEL_ORDER: readonly JointName[] = ['shoulder', 'elbow', 'wrist'];

const WHICH_JA: Record<Which, string> = {
  bottom: '腕を下ろして、ひじを伸ばしてください',
  top: '腕を巻き上げてください',
};

function sideLabel(side: 'left' | 'right'): string {
  return side === 'left' ? '左' : '右';
}

/** ROM の単位。signal によって度数と上腕長比で変わる。 */
function romUnit(signal: SignalKind): string {
  return signal === 'elbow-angle' ? '°' : '';
}

function fmt(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

/**
 * 下端(伸展)→上端(屈曲)の2ステップ、各1秒記録。ここが実質的な「唯一の不正対策」
 * （calibration.ts の resolveCalibration）の入り口。
 *
 * ★ 使う腕を宣言させない。1ステップで**両腕**を同時に観測し、
 * resolveCalibration() が「実際に動かした腕」を自動で選ぶ。
 *
 * ★ カウントダウン中は**実測値をライブ表示**する。これが無いと、記録されている値が
 * 自分の意図した姿勢と一致しているかを確認する方法がまったく無い。
 */
export function createCalibrationWizard(root: HTMLElement, opts: CalibrationWizardOptions): void {
  root.className = 'dt-calibration-overlay';
  const windowMs = opts.windowMs ?? 1000;
  const countdownMs = opts.countdownMs ?? COUNTDOWN_MS;
  const container = document.createElement('div');
  container.className = 'dt-calibration-wizard';
  root.appendChild(container);

  let bottomCapture: ArmCapture | null = null;
  let topCapture: ArmCapture | null = null;
  let accepted: Calibration | null = null;
  let acceptedSide: 'left' | 'right' | null = null;
  let lastDiagnostics: CalibrationDiagnostics | null = null;
  let liveTimer: number | null = null;

  function stopLive(): void {
    if (liveTimer !== null) window.clearInterval(liveTimer);
    liveTimer = null;
  }

  /**
   * 現在フレームの実測値。カウントダウン/記録中のライブ表示用。
   *
   * ★ 関節ごとの score をここで出すのが重要。記録して失敗するまで待たずに、
   * 構えている最中に「手首が 0.2 しか出ていない」と気づける。
   */
  function liveText(): string {
    const kp = opts.source.lastKeypoints();
    if (!kp) return '体を検出できていません';
    const p = probeFrame({ at: 0, kp }, opts.signal, opts.source.frameSize());
    const arm = (a: typeof p.left, label: string): string => {
      const v = a.sample ? fmt(a.sample.raw, opts.signal === 'elbow-angle' ? 0 : 2) : '—';
      const j = JOINT_LABEL_ORDER.map((k) => {
        const score = a.scores[k];
        const outside = a.outside[k] > 0 ? '!' : '';
        return `${JOINT_JA[k]}${fmt(score, 2)}${outside}`;
      }).join(' ');
      return `${label} ${v}${romUnit(opts.signal)}  [${j}]`;
    };
    return `${arm(p.left, '左')}\n${arm(p.right, '右')}`;
  }

  function startLive(): void {
    stopLive();
    liveTimer = window.setInterval(() => {
      const el = container.querySelector<HTMLElement>('[data-el="live"]');
      if (el) el.textContent = liveText();
    }, 150);
  }

  function wireButtons(): void {
    container.querySelector('[data-action="start-bottom"]')?.addEventListener('click', () => countdown('bottom'));
    container.querySelector('[data-action="start-top"]')?.addEventListener('click', () => countdown('top'));
    container.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      bottomCapture = null;
      topCapture = null;
      accepted = null;
      acceptedSide = null;
      render({ kind: 'intro' });
    });
    container.querySelector('[data-action="begin"]')?.addEventListener('click', () => {
      if (accepted) opts.onComplete(accepted);
    });
  }

  function diagnosticsHtml(d: CalibrationDiagnostics, chosen: 'left' | 'right' | null): string {
    const unit = romUnit(opts.signal);
    const rows = d.candidates
      .map((c: ArmCandidate) => {
        const cls = c.side === chosen ? ' class="dt-cal-row--chosen"' : '';
        const ok = (v: boolean): string => (v ? '✓' : '✗');
        const digits = opts.signal === 'elbow-angle' ? 0 : 2;
        return `<tr${cls}>
          <td>${sideLabel(c.side)}腕${c.side === chosen ? ' ←採用' : ''}</td>
          <td>${fmt(c.bottomRaw, digits)}${unit}</td>
          <td>${fmt(c.topRaw, digits)}${unit}</td>
          <td>${fmt(c.rom, digits)}${unit}</td>
          <td>${fmt(c.scoreP10)}</td>
          <td>${ok(c.confidenceOk)}</td>
          <td>${ok(c.romOk)}</td>
          <td>${ok(c.directionOk)}</td>
        </tr>`;
      })
      .join('');

    const frontWarning =
      d.view === 'front' && opts.signal === 'elbow-angle'
        ? `<p class="dt-calibration-wizard__warn">⚠ 正面向きに見えます。肘の角度は正面からだと画像上で潰れて
           精度が出ません。体を斜め45度に向けるか、信号を wrist-height にしてください。</p>`
        : '';

    return `
      <table class="dt-cal-table">
        <thead><tr>
          <th>腕</th><th>下端</th><th>上端</th><th>ROM</th>
          <th>信頼度<br>(p10)</th><th>信頼度<br>OK</th><th>ROM<br>OK</th><th>向き<br>OK</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${jointTableHtml(d)}
      <p class="dt-calibration-wizard__meta">
        推定した体の向き: <b>${VIEW_JA[d.view]}</b>（肩幅/上腕長 = ${fmt(d.shoulderRatio)}）<br>
        上腕長: ${fmt(d.armLenPx, 0)}px ／ 姿勢を取れなかったフレーム: ${d.droppedFrames}
      </p>
      ${frontWarning}
    `;
  }

  /**
   * 関節別の内訳テーブル。★「体がよく見えていません」の原因特定はこれが本体。
   * 1フレームの score は min(肩,肘,手首) に潰れているので、集約値だけでは
   * どの関節が原因か分からない（手首なのか肩なのかで対処が全く違う）。
   */
  function jointTableHtml(d: CalibrationDiagnostics): string {
    const rows = d.joints
      .map((r: JointDiagnosticRow) => {
        const cls = r.isBottleneck ? ' class="dt-cal-row--bad"' : '';
        const outside = r.outsideRatio > 0 ? `${Math.round(r.outsideRatio * 100)}%` : '—';
        return `<tr${cls}>
          <td>${sideLabel(r.side)}・${JOINT_JA[r.joint]}</td>
          <td>${fmt(r.bottomScoreP10)}</td>
          <td>${fmt(r.topScoreP10)}</td>
          <td>${outside}</td>
          <td>${r.isBottleneck ? '⚠ ここが原因' : ''}</td>
        </tr>`;
      })
      .join('');
    return `
      <p class="dt-calibration-wizard__meta">関節ごとの信頼度（必要: <b>${fmt(d.minScore)}</b> 以上）:</p>
      <table class="dt-cal-table">
        <thead><tr><th>関節</th><th>下端</th><th>上端</th><th>画面外</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="dt-calibration-wizard__meta">
        「画面外」= その関節が画面の端2%以内/外にいたフレームの割合。
        手首で高い場合は<b>腕を下ろしたときに手首が画面外に出ています</b> → 下がる/カメラを上に向ける。
      </p>`;
  }

  function render(step: Step): void {
    if (step.kind !== 'countdown' && step.kind !== 'recording') stopLive();

    switch (step.kind) {
      case 'intro':
        container.innerHTML = `
          <h2>キャリブレーション</h2>
          <ol class="dt-calibration-wizard__steps">
            <li><b>頭から膝まで</b>が画面に入るよう下がり、<b>画面の中央</b>に立つ。</li>
            <li>片腕でカールする（左右どちらでもよく、自動で判定します）。</li>
            <li>ボタンを押すと<b>${countdownMs / 1000}秒のカウントダウン</b>のあとに記録が始まります。
                押したあとに構え直す時間があります。</li>
          </ol>
          <p>1回目は<b>腕を下ろして伸ばした状態</b>、2回目は<b>巻き上げた状態</b>を記録します。</p>
          <button data-action="start-bottom">開始</button>
        `;
        break;

      case 'countdown':
        container.innerHTML = `
          <p class="dt-calibration-wizard__instruction">${WHICH_JA[step.which]}</p>
          <p class="dt-calibration-wizard__countdown">${Math.ceil(step.remainMs / 1000)}</p>
          <p class="dt-calibration-wizard__meta">この姿勢のまま待ってください。いま測れている値:</p>
          <p class="dt-calibration-wizard__live" data-el="live">${liveText()}</p>
        `;
        startLive();
        break;

      case 'recording':
        container.innerHTML = `
          <p class="dt-calibration-wizard__recording">記録中…（${WHICH_JA[step.which]}）</p>
          <p class="dt-calibration-wizard__live" data-el="live">${liveText()}</p>
        `;
        startLive();
        break;

      case 'bottom-done':
        container.innerHTML = `
          <p class="dt-calibration-wizard__success">下端（伸ばした状態）を記録しました。</p>
          <p>次は<b>巻き上げた状態</b>です。ボタンを押すとカウントダウンが始まります。</p>
          <button data-action="start-top">次へ</button>
          <button data-action="retry" class="dt-calibration-wizard__secondary">やり直す</button>
        `;
        break;

      case 'result':
        if (step.failure) {
          container.innerHTML = `
            <p class="dt-calibration-wizard__error">キャリブレーションに失敗しました</p>
            <p>${FAIL_REASON_JA[step.failure.reason]}</p>
            ${diagnosticsHtml(step.failure.diagnostics, null)}
            <button data-action="retry">最初からやり直す</button>
          `;
        } else if (accepted && acceptedSide && lastDiagnostics) {
          container.innerHTML = `
            <p class="dt-calibration-wizard__success">キャリブレーション完了</p>
            <p><b>${sideLabel(acceptedSide)}腕</b>を使います。</p>
            ${diagnosticsHtml(lastDiagnostics, acceptedSide)}
            <button data-action="begin">はじめる</button>
            <button data-action="retry" class="dt-calibration-wizard__secondary">やり直す</button>
          `;
        }
        break;
    }
    wireButtons();
  }

  /**
   * カウントダウン → 記録 → 次のステップ。
   *
   * ★ 残り時間は**壁時計で測る**（tick ごとに固定値を引かない）。毎フレーム
   * MoveNet の推論が走っている間はメインスレッドが詰まって setInterval が遅延し、
   * 引き算方式だと「4秒のカウントダウンが体感7秒」のようにずれる（実測で確認）。
   */
  function countdown(which: Which): void {
    const endAt = performance.now() + countdownMs;
    render({ kind: 'countdown', which, remainMs: countdownMs });
    const timer = window.setInterval(() => {
      const remain = endAt - performance.now();
      if (remain > 0) {
        // 数字だけ差し替える（innerHTML を作り直すとライブ表示がちらつく）
        const el = container.querySelector<HTMLElement>('.dt-calibration-wizard__countdown');
        if (el) el.textContent = String(Math.ceil(remain / 1000));
        return;
      }
      window.clearInterval(timer);
      void record(which);
    }, COUNTDOWN_TICK_MS);
  }

  async function record(which: Which): Promise<void> {
    render({ kind: 'recording', which });
    const capture = await opts.source.probe(windowMs, opts.signal);
    if (which === 'bottom') {
      bottomCapture = capture;
      render({ kind: 'bottom-done' });
    } else {
      topCapture = capture;
      finish();
    }
  }

  function finish(): void {
    if (!bottomCapture || !topCapture) return; // 起こらないはずの型ガード
    const result = resolveCalibration(opts.signal, bottomCapture, topCapture, Date.now());
    lastDiagnostics = result.diagnostics;
    if (result.ok) {
      accepted = result.calibration;
      acceptedSide = result.calibration.side === 'left' ? 'left' : 'right';
      render({ kind: 'result' });
    } else {
      accepted = null;
      acceptedSide = null;
      render({ kind: 'result', failure: { reason: result.reason, diagnostics: result.diagnostics } });
    }
  }

  render({ kind: 'intro' });
}
