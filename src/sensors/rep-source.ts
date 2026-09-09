import type { Calibration } from '../core/detect/calibration';
import type { DetectorConfig, DetectorDiagnosticHint } from '../core/detect/rep-detector';
import { Emitter } from '../core/emitter';
import type { ArmSide, Ms, RepEvent, RepPhase, TrackingState } from '../core/types';
import { createKeyboardSource } from './keyboard-source';
import { createManualSignalSource } from './manual-signal-source';
import { createPoseSource } from './pose/pose-source';

export interface RepSourceEvents {
  rep: RepEvent; // valid / invalid 両方を emit する
  progress: { value: number; phase: RepPhase; at: Ms }; // 0..1。HUDゲージ用（毎フレーム）
  tracking: TrackingState;
  /** dev panel 用。source はカメラが実際に採用した設定（非CVソースでは null）。 */
  diag: {
    fps: number;
    inferMs: number;
    dropped: number;
    source: { width: number; height: number; fps: number } | null;
    /**
     * 判定に使っている腕の関節別 score（肩/肘/手首）。
     * ★ レップの無効理由 'low_confidence' は min(肩,肘,手首) で決まるので、
     * どの関節が落ちているかを運動中にリアルタイムで見られないと対処できない。
     */
    joints: { shoulder: number; elbow: number; wrist: number } | null;
  };
  /**
   * 沈黙診断。「信号は動いているのにレップが出ない」を黙って放置しないための通知。
   *
   * ★ 以前は detector が計算したこれを pose-source が**捨てていた**（dev panel が
   * progress のグラフを見れば分かる、という理屈だったが、グラフを読めるのは
   * 実装者だけで、運動している本人には何も伝わらない）。計画で「省略してはいけない
   * もの」の1番目に挙げていた機構が実質存在しない状態だったので、HUD まで配線した。
   */
  diagnostic: { hint: DetectorDiagnosticHint; observedMax: number; observedMin: number };
}

/**
 * レップを検知して RepEvent を emit するものの共通境界。
 *
 * 検出器（角度→レップの判定ロジック）は各実装の内部に隠れる。keyboard-source は信号を
 * 持たず RepEvent を捏造し、将来の IMU ソースは加速度から独自に検出する（肘角度が存在
 * しない）— コントローラは RepEvent だけ知っていればよく、下流が完全にセンサー非依存になる。
 *
 * sample() / reconfigure() は RepSource 共通のシグネチャには含めない — 実際に必要と
 * するのは webcam-movenet（PoseSource）だけなので、そちらの拡張インターフェースに
 * 生やす（manual-signal-source の setValue と同じパターン）。共通インターフェースを
 * 太らせない。
 */
export interface RepSource {
  readonly kind: 'keyboard' | 'manual' | 'webcam-movenet'; // 将来: 'replay' | 'imu' | 'aruco'
  readonly caps: { readonly calibration: boolean; readonly progress: boolean; readonly preview: boolean };
  readonly events: Emitter<RepSourceEvents>;

  /** 重い初期化（モデルロード / カメラ許可）。失敗は throw。 */
  init(): Promise<void>;
  /** フレームポンプ開始。冪等。 */
  start(): void;
  /** 停止。熱対策で頻繁に呼ばれる想定。冪等。 */
  stop(): void;
  dispose(): Promise<void>;
}

export interface RepSourceDeps {
  /** 'manual' 用。normalize/denormalize の基準になるキャリブレーション。 */
  readonly calibration?: Calibration;
  readonly detectorConfig?: DetectorConfig;
  /** 'webcam-movenet' 用。省略時は仮のデフォルト値（M5 のキャリブレーションで置き換える）。 */
  readonly side?: ArmSide;
}

export function createRepSource(kind: RepSource['kind'], deps: RepSourceDeps = {}): RepSource {
  switch (kind) {
    case 'keyboard':
      return createKeyboardSource();
    case 'manual':
      if (!deps.calibration) throw new Error('manual RepSource には calibration が必要');
      return createManualSignalSource(deps.calibration, deps.detectorConfig);
    case 'webcam-movenet': {
      // exactOptionalPropertyTypes: true のため、値がある場合のみプロパティを詰める
      // （{ side: undefined } のような明示的 undefined は Partial<T> に代入できない。
      // プロパティは readonly なので条件付きスプレッドで構築する）。
      const patch: Parameters<typeof createPoseSource>[0] = {
        ...(deps.calibration ? { calibration: deps.calibration } : {}),
        ...(deps.detectorConfig ? { detectorConfig: deps.detectorConfig } : {}),
        ...(deps.side ? { side: deps.side } : {}),
      };
      return createPoseSource(patch);
    }
  }
}
