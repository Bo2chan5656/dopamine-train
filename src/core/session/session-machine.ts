import type { TrackingState } from '../types';

export type SessionState =
  | 'boot'
  | 'needs-permission'
  | 'calibrating'
  | 'earning' // 推論ON、プレイヤー停止
  | 'watching' // 推論OFF（熱対策）、クレジット消費中
  | 'depleted' // 停止 + スクロールロック
  | 'tracking-lost' // 稼働中に見失った
  | 'cooldown' // 安全機構: レップ過多による強制休憩
  | 'daily-capped'; // 日次上限に到達

export type SessionEvent =
  | { readonly t: 'sensor-ready'; readonly needsCalibration: boolean }
  | { readonly t: 'permission-denied' }
  | { readonly t: 'calibrated' }
  | { readonly t: 'credit-granted' }
  | { readonly t: 'credit-depleted' }
  | { readonly t: 'user-watch' }
  | { readonly t: 'user-earn' }
  | { readonly t: 'tracking'; readonly state: TrackingState }
  | { readonly t: 'daily-cap-reached' }
  | { readonly t: 'daily-cap-cleared' }
  | { readonly t: 'cooldown-start' }
  | { readonly t: 'cooldown-end' };

/**
 * 純関数の状態遷移表。SessionController がまだ実際に踏むのは
 * boot → earning ⇄ watching の範囲のみ（M1/M2 時点の RepSource は
 * calibration も tracking-lost も持たないため）。calibrating / tracking-lost /
 * needs-permission / cooldown / daily-capped は M4-M5-M8 で対応する RepSource /
 * 安全機構が実装されてから SessionController に配線する。ここでは将来の配線先
 * として型と遷移だけを先に定義し、総当たりでテストできる状態にしておく。
 *
 * 未定義の (state, event) の組は state をそのまま返す（no-op）。
 * cooldown-start / daily-cap-reached はどの状態からでも割り込む安全機構として最優先で扱う。
 */
export function transition(state: SessionState, event: SessionEvent): SessionState {
  if (event.t === 'cooldown-start') return 'cooldown';
  if (event.t === 'daily-cap-reached') return 'daily-capped';

  switch (event.t) {
    case 'cooldown-end':
      return state === 'cooldown' ? 'earning' : state;
    case 'daily-cap-cleared':
      return state === 'daily-capped' ? 'earning' : state;
    case 'permission-denied':
      return 'needs-permission';
    case 'sensor-ready':
      return state === 'boot' || state === 'needs-permission'
        ? event.needsCalibration
          ? 'calibrating'
          : 'earning'
        : state;
    case 'calibrated':
      return state === 'calibrating' ? 'earning' : state;
    case 'credit-granted':
      return state === 'earning' || state === 'depleted' ? 'watching' : state;
    case 'credit-depleted':
      return state === 'watching' ? 'depleted' : state;
    case 'user-watch':
      return state === 'earning' ? 'watching' : state;
    case 'user-earn':
      return state === 'watching' ? 'earning' : state;
    case 'tracking':
      if (event.state.kind === 'lost') {
        return state === 'earning' || state === 'watching' || state === 'calibrating' ? 'tracking-lost' : state;
      }
      if (event.state.kind === 'ok') {
        return state === 'tracking-lost' ? 'earning' : state;
      }
      return state;
    default:
      return state;
  }
}
