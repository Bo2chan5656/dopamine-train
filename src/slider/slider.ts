import { Emitter } from '../core/emitter';

export interface SliderEvents {
  state: { playing: boolean; index: number };
  ended: { index: number };
  'user-nav': { direction: 1 | -1; blocked: boolean }; // ロック中の操作 → UI で理由を出す
}

/**
 * バンキング方式では報酬は「スライドが進むこと」ではなく「再生できる時間」。
 * この層の中核プリミティブは再生ゲートであり、next() は副次的。
 * M2 で local-player-slider（自前プレイヤー）、M6+ で shorts-extension が実装として乗る。
 */
export interface Slider {
  readonly kind: 'noop' | 'local-player' | 'shorts-extension';
  readonly events: Emitter<SliderEvents>;

  attach(): Promise<void>;
  detach(): Promise<void>;

  play(): Promise<void>;
  pause(reason: 'depleted' | 'tracking-lost' | 'hidden' | 'user' | 'cooldown'): Promise<void>;
  /** wheel/touch/keyboard の全経路を封じる。クレジット枯渇時に true。 */
  setLocked(locked: boolean, reason?: string): void;
  next(reason: 'reward' | 'user' | 'ended'): Promise<void>;

  isPlaying(): boolean;
  /** 早送りでクレジットを引き延ばすのを防ぐ。1.0 固定。 */
  setPlaybackRate?(rate: 1.0): void;
}
