import { describe, expect, it, vi } from 'vitest';
import { createLedger, type LedgerSnapshot } from '../src/core/credit/ledger';
import type { CreditPolicy } from '../src/core/credit/policy';
import type { RepEvent } from '../src/core/types';

function policy(overrides: Partial<CreditPolicy> = {}): CreditPolicy {
  return {
    repsPerGrant: 10,
    secondsPerGrant: 60,
    maxBankedSeconds: 600,
    creditExpiryMs: null,
    dailyRepCap: 300,
    lowWarningSeconds: 10,
    grant: 'bank',
    ...overrides,
  };
}

function validRep(id: number): RepEvent {
  return {
    id,
    at: id,
    concentricMs: 700,
    eccentricMs: 900,
    romRatio: 1,
    peak: 1,
    minScore: 1,
    side: 'right',
    valid: true,
    rejects: [],
  };
}

function invalidRep(id: number): RepEvent {
  return { ...validRep(id), valid: false, rejects: ['too_fast'] };
}

describe('CreditLedger', () => {
  it('N未満のレップでは付与されない', () => {
    const ledger = createLedger(policy({ repsPerGrant: 10 }), null);
    const granted = vi.fn();
    ledger.events.on('granted', granted);

    for (let i = 1; i <= 9; i++) ledger.creditRep(validRep(i), 0);

    expect(granted).not.toHaveBeenCalled();
    expect(ledger.balanceSeconds).toBe(0);
    expect(ledger.pendingReps).toBe(9);
  });

  it('Nレップ目でちょうどX秒付与される', () => {
    const ledger = createLedger(policy({ repsPerGrant: 10, secondsPerGrant: 60 }), null);
    const granted = vi.fn();
    ledger.events.on('granted', granted);

    for (let i = 1; i <= 10; i++) ledger.creditRep(validRep(i), 0);

    expect(granted).toHaveBeenCalledTimes(1);
    expect(granted).toHaveBeenCalledWith({ seconds: 60, balance: 60, totalReps: 10 });
    expect(ledger.balanceSeconds).toBe(60);
    expect(ledger.pendingReps).toBe(0);
  });

  it('無効レップは rejected(invalid) のみで pendingReps を変えない', () => {
    const ledger = createLedger(policy(), null);
    const rejected = vi.fn();
    const progress = vi.fn();
    ledger.events.on('rejected', rejected);
    ledger.events.on('progress', progress);

    ledger.creditRep(invalidRep(1), 0);

    expect(rejected).toHaveBeenCalledWith({ rep: invalidRep(1), reason: 'invalid' });
    expect(progress).not.toHaveBeenCalled();
    expect(ledger.pendingReps).toBe(0);
  });

  it('maxBankedSeconds で打ち止めになり、超過分は banked_cap で reject される', () => {
    const ledger = createLedger(
      policy({ repsPerGrant: 10, secondsPerGrant: 60, maxBankedSeconds: 90 }),
      null,
    );
    const granted = vi.fn();
    const rejected = vi.fn();
    ledger.events.on('granted', granted);
    ledger.events.on('rejected', rejected);

    for (let i = 1; i <= 20; i++) ledger.creditRep(validRep(i), 0);

    expect(granted).toHaveBeenCalledTimes(2);
    expect(granted).toHaveBeenNthCalledWith(1, { seconds: 60, balance: 60, totalReps: 10 });
    expect(granted).toHaveBeenNthCalledWith(2, { seconds: 30, balance: 90, totalReps: 20 });
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledWith({ rep: validRep(20), reason: 'banked_cap' });
    expect(ledger.balanceSeconds).toBe(90); // 上限を超えない
  });

  it('日次上限に達すると以降の有効レップは daily_cap で reject される', () => {
    const ledger = createLedger(policy({ repsPerGrant: 1, secondsPerGrant: 60, dailyRepCap: 1 }), null);
    const granted = vi.fn();
    const rejected = vi.fn();
    ledger.events.on('granted', granted);
    ledger.events.on('rejected', rejected);

    ledger.creditRep(validRep(1), 0); // ちょうど上限まで → 付与される
    ledger.creditRep(validRep(2), 0); // 上限超過 → reject

    expect(granted).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledWith({ rep: validRep(2), reason: 'daily_cap' });
    expect(ledger.balanceSeconds).toBe(60); // 2回目の付与はない
    expect(ledger.todayReps).toBe(1);
  });

  it('consume は残高を下限0にクランプする（マイナスにならない）', () => {
    const ledger = createLedger(policy(), null);
    ledger.creditRep(validRep(1), 0); // pendingReps=1 だけでは付与されない
    // 直接 10 レップ分付与させて残高を作る
    for (let i = 2; i <= 10; i++) ledger.creditRep(validRep(i), 0);
    expect(ledger.balanceSeconds).toBe(60);

    ledger.consume(20_000, 1_000); // 20秒分。60秒しかない残高を大幅に超えて消費要求
    expect(ledger.balanceSeconds).toBe(40);

    ledger.consume(9_999_000, 2_000); // 極端に大きい消費要求
    expect(ledger.balanceSeconds).toBe(0);
  });

  it('low と depleted はそれぞれ1回だけ発火する（複数回の consume をまたいでも）', () => {
    const ledger = createLedger(policy({ repsPerGrant: 10, secondsPerGrant: 60, lowWarningSeconds: 10 }), null);
    for (let i = 1; i <= 10; i++) ledger.creditRep(validRep(i), 0);
    expect(ledger.balanceSeconds).toBe(60);

    const low = vi.fn();
    const depleted = vi.fn();
    ledger.events.on('low', low);
    ledger.events.on('depleted', depleted);

    ledger.consume(51_000, 1_000); // 60 -> 9 (閾値10を下回る)
    expect(low).toHaveBeenCalledTimes(1);
    expect(low).toHaveBeenCalledWith({ balance: 9 });

    ledger.consume(1_000, 2_000); // 9 -> 8。閾値以下のまま推移するが再発火しない
    expect(low).toHaveBeenCalledTimes(1);

    ledger.consume(8_000, 3_000); // 8 -> 0
    expect(depleted).toHaveBeenCalledTimes(1);

    ledger.consume(1_000, 4_000); // 既に0。再発火しない
    ledger.consume(1_000, 5_000);
    expect(depleted).toHaveBeenCalledTimes(1);
    expect(low).toHaveBeenCalledTimes(1);
  });

  it('再付与されると low/depleted の dedupe フラグがリセットされ、再度枯渇すれば再発火する', () => {
    const ledger = createLedger(policy({ repsPerGrant: 10, secondsPerGrant: 60, lowWarningSeconds: 10 }), null);
    for (let i = 1; i <= 10; i++) ledger.creditRep(validRep(i), 0);
    ledger.consume(60_000, 1_000); // 60 -> 0

    const depleted = vi.fn();
    ledger.events.on('depleted', depleted);

    for (let i = 11; i <= 20; i++) ledger.creditRep(validRep(i), 2_000); // 再付与 60秒
    expect(ledger.balanceSeconds).toBe(60);

    ledger.consume(60_000, 3_000); // 再度 60 -> 0
    expect(depleted).toHaveBeenCalledTimes(1); // 再付与後の枯渇として1回発火する
  });

  it('creditExpiryMs を過ぎるとアクティビティがない残高は失効し depleted が発火する', () => {
    const ledger = createLedger(policy({ repsPerGrant: 10, secondsPerGrant: 60, creditExpiryMs: 5_000 }), null);
    for (let i = 1; i <= 10; i++) ledger.creditRep(validRep(i), 0); // lastActivityAtWall = 0
    expect(ledger.balanceSeconds).toBe(60);

    const depleted = vi.fn();
    ledger.events.on('depleted', depleted);

    ledger.refresh(4_999); // まだ失効しない
    expect(ledger.balanceSeconds).toBe(60);
    expect(depleted).not.toHaveBeenCalled();

    ledger.refresh(5_000); // 失効
    expect(ledger.balanceSeconds).toBe(0);
    expect(depleted).toHaveBeenCalledTimes(1);
  });

  it('consume はアクティビティとして扱われるため、再生中は失効しない', () => {
    const ledger = createLedger(policy({ repsPerGrant: 10, secondsPerGrant: 3600, creditExpiryMs: 5_000 }), null);
    for (let i = 1; i <= 10; i++) ledger.creditRep(validRep(i), 0);

    ledger.consume(100, 4_000); // アクティビティを更新
    ledger.refresh(8_999); // 最終アクティビティ(4000)から5000未満 → まだ失効しない
    expect(ledger.balanceSeconds).toBeGreaterThan(0);
  });

  it('ローカル日付が変わると todayReps がロールオーバーする', () => {
    const day1 = new Date(2026, 0, 1, 23, 59, 0).getTime();
    const day2 = new Date(2026, 0, 2, 0, 1, 0).getTime();
    const snapshot: LedgerSnapshot = {
      balanceSeconds: 0,
      pendingReps: 0,
      totalRepsAllTime: 5,
      todayReps: 5,
      todayKey: '2026-01-01',
      lastActivityAtWall: day1,
    };
    const ledger = createLedger(policy({ repsPerGrant: 5, dailyRepCap: 5 }), snapshot);
    expect(ledger.todayReps).toBe(5);

    // ロールオーバー前は日次上限ちょうどなので、有効レップでも reject される
    const rejectedBefore = vi.fn();
    ledger.events.on('rejected', rejectedBefore);
    ledger.creditRep(validRep(100), day1);
    expect(rejectedBefore).toHaveBeenCalledWith({ rep: validRep(100), reason: 'daily_cap' });

    ledger.refresh(day1); // 同じ日 → 変化なし
    expect(ledger.todayReps).toBe(5);

    ledger.refresh(day2); // 日付が変わった → リセット
    expect(ledger.todayReps).toBe(0);

    // リセット後は日次上限に引っかからず、また付与できることを確認
    const granted = vi.fn();
    ledger.events.on('granted', granted);
    for (let i = 1; i <= 5; i++) ledger.creditRep(validRep(i), day2);
    expect(granted).toHaveBeenCalledTimes(1);
  });

  it('toJSON で作ったスナップショットから復元すると同じ状態になる（ラウンドトリップ）', () => {
    const p = policy({ repsPerGrant: 10, secondsPerGrant: 60 });
    const original = createLedger(p, null);
    for (let i = 1; i <= 15; i++) original.creditRep(validRep(i), 0); // 1回付与 + 端数5
    original.consume(10_000, 1_000);

    const snapshot = original.toJSON();
    const restored = createLedger(p, snapshot);

    expect(restored.balanceSeconds).toBe(original.balanceSeconds);
    expect(restored.pendingReps).toBe(original.pendingReps);
    expect(restored.todayReps).toBe(original.todayReps);
    expect(restored.toJSON()).toEqual(snapshot);
  });

  it('復元直後は残高が既に低い/空でも low・depleted を再通知しない', () => {
    const p = policy({ lowWarningSeconds: 10 });
    const snapshotEmpty: LedgerSnapshot = {
      balanceSeconds: 0,
      pendingReps: 0,
      totalRepsAllTime: 0,
      todayReps: 0,
      todayKey: '2026-01-01',
      lastActivityAtWall: null,
    };
    const ledger = createLedger(p, snapshotEmpty);
    const depleted = vi.fn();
    const low = vi.fn();
    ledger.events.on('depleted', depleted);
    ledger.events.on('low', low);

    ledger.consume(0, 0); // dtMs<=0 は即 return するので何も起きない
    ledger.refresh(0);

    expect(depleted).not.toHaveBeenCalled();
    expect(low).not.toHaveBeenCalled();
  });
});
