import type { LedgerSnapshot } from '../core/credit/ledger';
import { clampPolicy, type CreditPolicy } from '../core/credit/policy';
import type { Settings } from '../core/session/controller';

const KEY_SETTINGS = 'dt.settings.v1';
const KEY_LEDGER = 'dt.ledger.v1';

/**
 * localStorage の薄いラッパ。全て try/catch する: プライベートブラウジング等で
 * localStorage が例外を投げる環境でも、アプリはフォールバック値で普通に動く。
 * 入力元は自分の設定パネルと localStorage だけなので、zod 等は使わず手書きで検証する。
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (!raw) return { credit: clampPolicy({}) };
    const parsed = JSON.parse(raw) as { credit?: Partial<CreditPolicy> };
    return { credit: clampPolicy(parsed.credit ?? {}) };
  } catch {
    return { credit: clampPolicy({}) };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  } catch {
    // 保存できない環境では黙って諦める（アプリはメモリ上の状態で動き続ける）
  }
}

export function loadLedgerSnapshot(): LedgerSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY_LEDGER);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLedgerSnapshotShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLedgerSnapshot(snapshot: LedgerSnapshot): void {
  try {
    localStorage.setItem(KEY_LEDGER, JSON.stringify(snapshot));
  } catch {
    // 同上
  }
}

function isLedgerSnapshotShape(v: unknown): v is LedgerSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.balanceSeconds === 'number' &&
    typeof o.pendingReps === 'number' &&
    typeof o.totalRepsAllTime === 'number' &&
    typeof o.todayReps === 'number' &&
    typeof o.todayKey === 'string' &&
    (o.lastActivityAtWall === null || typeof o.lastActivityAtWall === 'number')
  );
}
