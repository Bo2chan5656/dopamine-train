import { Emitter } from '../emitter';
import type { RepEvent } from '../types';
import type { CreditPolicy } from './policy';

export interface LedgerEvents {
  granted: { seconds: number; balance: number; totalReps: number };
  progress: { pendingReps: number; needed: number }; // N 未満の端数
  low: { balance: number };
  depleted: undefined;
  rejected: { rep: RepEvent; reason: 'invalid' | 'daily_cap' | 'banked_cap' };
  changed: { balance: number }; // HUD の秒表示用。consume/creditRep/refresh の全残高変化で発火
}

/** localStorage に永続化するスナップショット。プレーンな JSON。 */
export interface LedgerSnapshot {
  readonly balanceSeconds: number;
  readonly pendingReps: number;
  readonly totalRepsAllTime: number;
  readonly todayReps: number;
  readonly todayKey: string; // ローカル日付（例 "2026-09-09"）。日次ロールオーバー判定用
  readonly lastActivityAtWall: number | null; // 失効判定用。creditRep/consume の両方で更新される
}

export interface CreditLedger {
  readonly events: Emitter<LedgerEvents>;
  readonly balanceSeconds: number;
  readonly pendingReps: number;
  readonly todayReps: number;

  /**
   * 有効レップを計上する。無効レップ・日次上限超過は 'rejected' を emit して即 return。
   * nowWall は失効判定用の「最終アクティビティ時刻」の更新に使うだけ。省略時は Date.now()。
   */
  creditRep(rep: RepEvent, nowWall?: number): void;
  /** ★呼び出し側が「再生中かつ可視」のときだけ呼ぶこと。ここではその判断をしない。 */
  consume(dtMs: number, nowWall: number): void;
  /** 日次ロールオーバーとクレジット失効の評価。1秒に1回程度呼ぶ想定。 */
  refresh(nowWall: number): void;

  toJSON(): LedgerSnapshot;
}

export function createLedger(policy: CreditPolicy, snapshot: LedgerSnapshot | null): CreditLedger {
  let balanceSeconds = snapshot?.balanceSeconds ?? 0;
  let pendingReps = snapshot?.pendingReps ?? 0;
  let totalRepsAllTime = snapshot?.totalRepsAllTime ?? 0;
  let todayReps = snapshot?.todayReps ?? 0;
  let todayKey = snapshot?.todayKey ?? localDateKey(Date.now());
  let lastActivityAtWall = snapshot?.lastActivityAtWall ?? null;

  // 復元直後に「何も変わっていないのに」low/depleted を再通知しないための dedupe フラグ。
  let hasWarnedLow = balanceSeconds > 0 && balanceSeconds <= policy.lowWarningSeconds;
  let hasNotifiedDepleted = balanceSeconds <= 0;

  const events = new Emitter<LedgerEvents>();

  function notifyDepletedIfNeeded(): void {
    if (hasNotifiedDepleted) return;
    hasNotifiedDepleted = true;
    events.emit('depleted', undefined);
  }

  function creditRep(rep: RepEvent, nowWall: number = Date.now()): void {
    if (!rep.valid) {
      events.emit('rejected', { rep, reason: 'invalid' });
      return;
    }
    if (todayReps >= policy.dailyRepCap) {
      events.emit('rejected', { rep, reason: 'daily_cap' });
      return;
    }

    todayReps += 1;
    totalRepsAllTime += 1;
    pendingReps += 1;

    // policy.repsPerGrant は clampPolicy を通せば常に >=1 だが、直接 createLedger に
    // 未クランプの policy を渡された場合の無限ループを防ぐ最後の砦として Math.max する。
    const grantThreshold = Math.max(1, policy.repsPerGrant);
    while (pendingReps >= grantThreshold) {
      pendingReps -= grantThreshold;
      const before = balanceSeconds;
      balanceSeconds = Math.min(before + policy.secondsPerGrant, policy.maxBankedSeconds);
      const actualGranted = balanceSeconds - before;

      if (actualGranted > 0) {
        lastActivityAtWall = nowWall;
        hasWarnedLow = false;
        hasNotifiedDepleted = false;
      }
      events.emit('granted', { seconds: actualGranted, balance: balanceSeconds, totalReps: totalRepsAllTime });
      events.emit('changed', { balance: balanceSeconds });
      if (actualGranted < policy.secondsPerGrant) {
        // 銀行が満杯で付与の一部（または全部）が失われた。
        events.emit('rejected', { rep, reason: 'banked_cap' });
      }
    }
    events.emit('progress', { pendingReps, needed: grantThreshold });
  }

  function consume(dtMs: number, nowWall: number): void {
    if (dtMs <= 0) return;
    lastActivityAtWall = nowWall; // 消費中は「放置」ではない → 失効タイマーを進めさせない
    if (balanceSeconds <= 0) return; // 既に空。多重発火を避けるためここで抜ける

    const before = balanceSeconds;
    balanceSeconds = Math.max(0, balanceSeconds - dtMs / 1000);
    if (balanceSeconds !== before) {
      events.emit('changed', { balance: balanceSeconds });
    }
    if (before > policy.lowWarningSeconds && balanceSeconds <= policy.lowWarningSeconds && !hasWarnedLow) {
      hasWarnedLow = true;
      events.emit('low', { balance: balanceSeconds });
    }
    if (balanceSeconds <= 0) {
      notifyDepletedIfNeeded();
    }
  }

  function refresh(nowWall: number): void {
    const key = localDateKey(nowWall);
    if (key !== todayKey) {
      todayKey = key;
      todayReps = 0;
    }

    if (
      policy.creditExpiryMs !== null &&
      lastActivityAtWall !== null &&
      balanceSeconds > 0 &&
      nowWall - lastActivityAtWall >= policy.creditExpiryMs
    ) {
      balanceSeconds = 0;
      lastActivityAtWall = null;
      events.emit('changed', { balance: 0 });
      notifyDepletedIfNeeded();
    }
  }

  function toJSON(): LedgerSnapshot {
    return { balanceSeconds, pendingReps, totalRepsAllTime, todayReps, todayKey, lastActivityAtWall };
  }

  return {
    events,
    get balanceSeconds() {
      return balanceSeconds;
    },
    get pendingReps() {
      return pendingReps;
    },
    get todayReps() {
      return todayReps;
    },
    creditRep,
    consume,
    refresh,
    toJSON,
  };
}

/** epoch ms → ローカルタイムゾーンの "YYYY-MM-DD"。UTC ではなくローカル深夜でロールオーバーさせる。 */
function localDateKey(nowWallMs: number): string {
  const d = new Date(nowWallMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
