import type { Calibration } from '../core/detect/calibration';
import { denormalize } from '../core/detect/calibration';
import {
  createRepDetector,
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
  type DetectorState,
} from '../core/detect/rep-detector';
import { Emitter } from '../core/emitter';
import type { RepSource, RepSourceEvents } from './rep-source';

export interface ManualSignalSource extends RepSource {
  /** UI のスライダー等から呼ぶ。norm01 は 0..1（キャリブレーションの下端/上端に対応）。 */
  setValue(norm01: number, atMs?: number): void;
  /** dev 用: 検出器の内部状態を覗く（phase/lost/sessionMax）。 */
  snapshot(): DetectorState;
}

/**
 * カメラなしで RepDetector 本体を目視確認するための RepSource。UI のスライダーを
 * マウスでドラッグして 0..1 の正規化信号を手動で動かし、ステートマシンの遷移と
 * レップ計上を直接観察できる — これがカメラ導入(M4)前の最良の検証手段。
 *
 * 'diagnostic'（threshold_unreachable）は RepSourceEvents.diag（fps/inferMs/dropped、
 * カメラ性能の話）とは別物なので、そちらには流さない。必要なら snapshot() で見る。
 */
export function createManualSignalSource(
  cal: Calibration,
  cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): ManualSignalSource {
  const events = new Emitter<RepSourceEvents>();
  const detector = createRepDetector(cfg, cal, cal.side);
  let running = false;

  function setValue(norm01: number, atMs: number = performance.now()): void {
    if (!running) return;
    const raw = denormalize(norm01, cal);
    for (const o of detector.update({ at: atMs, raw, score: 1 })) {
      if (o.type === 'rep') events.emit('rep', o.rep);
      else if (o.type === 'progress') events.emit('progress', { value: o.value, phase: o.phase, at: atMs });
      else if (o.type === 'tracking') events.emit('tracking', o.state);
    }
  }

  return {
    kind: 'manual',
    caps: { calibration: false, progress: true, preview: false },
    events,
    async init(): Promise<void> {},
    start(): void {
      running = true;
    },
    stop(): void {
      running = false;
    },
    async dispose(): Promise<void> {
      running = false;
    },
    setValue,
    snapshot(): DetectorState {
      return detector.snapshot();
    },
  };
}
