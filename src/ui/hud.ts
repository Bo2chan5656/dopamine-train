import type { DetectorDiagnosticHint } from '../core/detect/rep-detector';
import type { HudPort, HudViewModel } from '../core/session/controller';
import type { RejectReason } from '../core/types';
import './styles/hud.css';

const REASON_JA: Record<RejectReason, string> = {
  too_fast: '速すぎます',
  too_slow: '遅すぎます',
  short_rom: '可動域が足りません',
  low_confidence: '体がよく見えていません',
  chatter: '間隔が短すぎます',
  fast_eccentric: '下ろすのが速すぎます（怪我に注意）',
};

/**
 * 沈黙診断の日本語化。「レップが増えない理由」を運動している本人に伝えるのが目的。
 * 抽象的な言い方にせず、次に何をすればいいかまで書く。
 */
const DIAGNOSTIC_JA: Record<DetectorDiagnosticHint, string> = {
  top_unreachable: '⚠ 巻き上げが足りません。キャリブレーション時と同じ高さまで上げてください',
  bottom_unreachable: '⚠ 伸ばしきれていません。毎回、腕を下まで戻してください',
};

interface HudDom {
  readonly root: HTMLElement;
  readonly status: HTMLElement;
  readonly balance: HTMLElement;
  readonly pending: HTMLElement;
  readonly today: HTMLElement;
  readonly reason: HTMLElement;
  readonly diagnostic: HTMLElement;
}

/**
 * 変化した要素だけ textContent を書き換える（差分は手で持つ。要素6個程度なので
 * diff ライブラリは不要）。毎フレーム update() が呼ばれる前提の実装。
 */
export function createHud(root: HTMLElement): HudPort {
  const dom = buildDom(root);
  let last: HudViewModel | null = null;

  return {
    update(vm: HudViewModel): void {
      if (last?.balanceSeconds !== vm.balanceSeconds) {
        dom.balance.textContent = formatSeconds(vm.balanceSeconds);
      }
      if (last?.pendingReps !== vm.pendingReps || last?.neededReps !== vm.neededReps) {
        const remain = Math.max(0, vm.neededReps - vm.pendingReps);
        dom.pending.textContent = remain > 0 ? `あと ${remain} レップ` : '付与済み';
      }
      if (last?.todayReps !== vm.todayReps || last?.dailyRepCap !== vm.dailyRepCap) {
        dom.today.textContent = `本日 ${vm.todayReps} / ${vm.dailyRepCap}`;
      }
      if (last?.locked !== vm.locked) {
        dom.root.style.setProperty(
          '--dt-state-color',
          vm.locked ? 'var(--dt-color-locked)' : 'var(--dt-color-active)',
        );
        dom.status.textContent = vm.locked ? 'ロック中 — 運動してください' : '再生中';
      }
      if (last?.lastRejectReasons !== vm.lastRejectReasons || last?.lastRepMetrics !== vm.lastRepMetrics) {
        dom.reason.textContent = formatRejects(vm);
      }
      if (last?.diagnostic !== vm.diagnostic) {
        dom.diagnostic.textContent = vm.diagnostic ? DIAGNOSTIC_JA[vm.diagnostic] : '';
      }
      last = vm;
    },
  };
}

/**
 * 無効理由に実測値を添える。★理由の文言だけでは対処できない —
 * 「体がよく見えていません」が 0.34 なのか 0.05 なのかで、
 * 「少し下がる」か「照明を根本的に変える」かが変わる。
 */
function formatRejects(vm: HudViewModel): string {
  if (vm.lastRejectReasons.length === 0) return '';
  const m = vm.lastRepMetrics;
  return vm.lastRejectReasons
    .map((r) => {
      const label = REASON_JA[r];
      if (!m) return label;
      if (r === 'low_confidence') return `${label}（信頼度 ${m.minScore.toFixed(2)}）`;
      if (r === 'too_fast' || r === 'too_slow') return `${label}（挙上 ${Math.round(m.concentricMs)}ms）`;
      if (r === 'short_rom') return `${label}（可動域 ${(m.romRatio * 100).toFixed(0)}%）`;
      return label;
    })
    .join(' / ');
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildDom(root: HTMLElement): HudDom {
  const container = document.createElement('div');
  container.className = 'dt-hud';
  container.innerHTML = `
    <div class="dt-hud__status" data-el="status"></div>
    <div class="dt-hud__balance" data-el="balance"></div>
    <div class="dt-hud__pending" data-el="pending"></div>
    <div class="dt-hud__today" data-el="today"></div>
    <div class="dt-hud__reason" data-el="reason"></div>
    <div class="dt-hud__diagnostic" data-el="diagnostic"></div>
  `;
  root.appendChild(container);

  function query(name: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`[data-el="${name}"]`);
    if (!el) throw new Error(`hud: missing element data-el="${name}"`);
    return el;
  }

  return {
    root: container,
    status: query('status'),
    balance: query('balance'),
    pending: query('pending'),
    today: query('today'),
    reason: query('reason'),
    diagnostic: query('diagnostic'),
  };
}
