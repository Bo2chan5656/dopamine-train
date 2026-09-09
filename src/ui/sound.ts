import type { SoundPort } from '../core/session/controller';

interface ToneSpec {
  readonly freq: number;
  readonly durationMs: number;
  readonly type?: OscillatorType;
}

/**
 * WebAudio の短いビープ。事前に AudioBuffer をレンダリングする最適化（設計検討時の
 * 案）は M4/M5 のカメラ駆動レップでレイテンシ予算がシビアになってから検討する。
 * M1（キーボードモック）の段階では OscillatorNode を都度生成する単純な実装で十分。
 *
 * AudioContext はブラウザの自動再生ポリシー上ユーザー操作が必要なため、最初の
 * beep() 呼び出し（= 最初の j/k キー押下）で遅延生成する。
 */
export function createSound(): SoundPort {
  let ctx: AudioContext | null = null;

  function ensureContext(): AudioContext {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  function beep({ freq, durationMs, type = 'sine' }: ToneSpec): void {
    const audioCtx = ensureContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  }

  return {
    rep(): void {
      beep({ freq: 880, durationMs: 60 });
    },
    invalid(): void {
      beep({ freq: 220, durationMs: 120, type: 'square' });
    },
    low(): void {
      beep({ freq: 440, durationMs: 200 });
    },
    depleted(): void {
      beep({ freq: 160, durationMs: 400, type: 'square' });
    },
  };
}
