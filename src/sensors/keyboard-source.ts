import { Emitter } from '../core/emitter';
import type { RejectReason, RepEvent } from '../core/types';
import type { RepSource, RepSourceEvents } from './rep-source';

// k キーを押すたびに6種の reject 理由を順番に回す。M1 の手動チェックで
// HUD の理由表示（日本語メッセージ）が全パターン確認できるようにするため。
const REJECT_CYCLE: readonly RejectReason[] = [
  'too_fast',
  'too_slow',
  'short_rom',
  'low_confidence',
  'chatter',
  'fast_eccentric',
];

/**
 * カメラなしで下流（Ledger / Slider / UI）を検証するためのモック RepSource。
 * j = 有効レップ、k = 無効レップ。CV は一切関与しない。
 */
export function createKeyboardSource(): RepSource {
  const events = new Emitter<RepSourceEvents>();
  let repId = 0;
  let rejectCycleIndex = 0;
  let running = false;

  function emitValidRep(): void {
    const rep: RepEvent = {
      id: ++repId,
      at: performance.now(),
      concentricMs: 700,
      eccentricMs: 900,
      romRatio: 1.0,
      peak: 1.0,
      minScore: 1, // 非CVソースなので信頼度チェックの対象外
      side: 'right',
      valid: true,
      rejects: [],
    };
    events.emit('rep', rep);
  }

  function emitInvalidRep(): void {
    const reason = REJECT_CYCLE[rejectCycleIndex % REJECT_CYCLE.length]!;
    rejectCycleIndex += 1;
    const rep: RepEvent = {
      id: ++repId,
      at: performance.now(),
      concentricMs: reason === 'too_fast' ? 150 : reason === 'too_slow' ? 5000 : 700,
      eccentricMs: reason === 'fast_eccentric' ? 150 : 900,
      romRatio: reason === 'short_rom' ? 0.3 : 1.0,
      peak: reason === 'short_rom' ? 0.5 : 1.0,
      minScore: reason === 'low_confidence' ? 0.1 : 1,
      side: 'right',
      valid: false,
      rejects: [reason],
    };
    events.emit('rep', rep);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!running) return;
    if (e.key === 'j') emitValidRep();
    else if (e.key === 'k') emitInvalidRep();
  }

  function start(): void {
    if (running) return;
    running = true;
    window.addEventListener('keydown', onKeyDown);
  }

  function stop(): void {
    if (!running) return;
    running = false;
    window.removeEventListener('keydown', onKeyDown);
  }

  return {
    kind: 'keyboard',
    caps: { calibration: false, progress: false, preview: false },
    events,
    async init(): Promise<void> {
      // ロードするものが何もない
    },
    start,
    stop,
    async dispose(): Promise<void> {
      stop();
    },
  };
}
