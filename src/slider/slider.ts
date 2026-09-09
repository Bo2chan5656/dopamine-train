import { Emitter } from '../core/emitter';

export interface SliderEvents {
  state: { playing: boolean; index: number };
  ended: { index: number };
  'user-nav': { direction: 1 | -1; blocked: boolean }; // ロック中の操作 → UI で理由を出す
}

/**
 * 視聴対象（YouTube Shorts）を操作する境界。
 *
 * バンキング方式では報酬は「スライドが進むこと」ではなく「再生できる時間」なので、
 * この層の中核プリミティブは**再生ゲート**であり next() は副次的。
 * per-slide 方式（1レップ1スライド）では next() が主役になる。
 *
 * ★ 実装は `extension/shorts-extension-slider.ts` の1つだけ。それでもインターフェースを
 * 残しているのは、`core/session/controller.ts` が `chrome.*` に依存しないための
 * 遮断膜として機能しているから（controller は Slider の型だけを見ており、
 * verbatimModuleSyntax によりランタイムコードは一切生成されない）。
 * かつて自前プレイヤー（local-player-slider）の実装もあったが、YouTube Shorts に
 * 一本化したため削除した。
 */
export interface Slider {
  readonly kind: 'shorts-extension';
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
