import { Emitter } from '../core/emitter';
import type { Slider, SliderEvents } from './slider';

/**
 * M1 で下流（SessionController / HUD）の配線を検証するためのプレースホルダー。
 * 実際の動画操作は一切しない。M2 で local-player-slider に置き換わる。
 */
export function createNoopSlider(): Slider {
  const events = new Emitter<SliderEvents>();
  let playing = false;
  let index = 0;

  return {
    kind: 'noop',
    events,

    async attach(): Promise<void> {
      console.log('[noop-slider] attach');
    },
    async detach(): Promise<void> {
      console.log('[noop-slider] detach');
    },
    async play(): Promise<void> {
      playing = true;
      console.log('[noop-slider] play');
      events.emit('state', { playing, index });
    },
    async pause(reason): Promise<void> {
      playing = false;
      console.log(`[noop-slider] pause (${reason})`);
      events.emit('state', { playing, index });
    },
    setLocked(locked, reason): void {
      console.log(`[noop-slider] setLocked(${locked}${reason ? `, ${reason}` : ''})`);
    },
    async next(reason): Promise<void> {
      index += 1;
      console.log(`[noop-slider] next (${reason}) -> index ${index}`);
      events.emit('state', { playing, index });
    },
    isPlaying(): boolean {
      return playing;
    },
  };
}
