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

interface HudDom {
  readonly root: HTMLElement;
  readonly status: HTMLElement;
  readonly balance: HTMLElement;
  readonly pending: HTMLElement;
  readonly today: HTMLElement;
  readonly reason: HTMLElement;
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
      if (last?.lastRejectReasons !== vm.lastRejectReasons) {
        dom.reason.textContent =
          vm.lastRejectReasons.length > 0 ? vm.lastRejectReasons.map((r) => REASON_JA[r]).join(' / ') : '';
      }
      last = vm;
    },
  };
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
  };
}
