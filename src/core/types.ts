// core/ 全体で共有する型。DOM / TFJS / chrome.* への依存はここに一切持ち込まない。

/** performance.now() 基準の単調時刻（ミリ秒）。Date.now() の壁時計とは混同しない。 */
export type Ms = number;

/** イベントリスナーの登録解除関数。 */
export type Unsubscribe = () => void;

export type ArmSide = 'left' | 'right' | 'both';

/** カメラに対する体の向き。M4 でどちらの SignalKind を主に使うか決める材料。 */
export type CameraView = 'front' | 'side45' | 'side';

/** RepDetector に渡す前の正規化スカラ信号の種類。 */
export type SignalKind = 'elbow-angle' | 'wrist-height';

/** レップ検出器のフェーズ（シュミットトリガの状態）。 */
export type RepPhase = 'unknown' | 'at-bottom' | 'at-top';

export type TrackingState =
  | { readonly kind: 'ok'; readonly minScore: number }
  | { readonly kind: 'low-confidence'; readonly minScore: number }
  | { readonly kind: 'lost'; readonly sinceMs: Ms }
  | { readonly kind: 'no-sensor'; readonly reason: string };

/** 無効レップの理由。「不正対策」ではなく「信号の妥当性検査」の結果として扱う。 */
export type RejectReason =
  | 'too_fast' // 最小レップ時間未満（チャタリング疑い）
  | 'too_slow' // 上昇に時間がかかりすぎ（途中停止・誤検出の疑い）
  | 'short_rom' // 可動域不足
  | 'low_confidence' // レップ中に score が低下
  | 'chatter' // 前レップから最小間隔未満
  | 'fast_eccentric'; // 下ろすのが速すぎる（重力任せ＝怪我リスク）

export interface RepEvent {
  readonly id: number;
  /** ★ performance.now() ではなく、上端閾値を越えたフレームの capture 時刻。レイテンシ計測の起点。 */
  readonly at: Ms;
  /** 下端 → 上端に要した時間。 */
  readonly concentricMs: Ms;
  /** 前レップの上端 → 今回の下端に要した時間。初回レップは null。 */
  readonly eccentricMs: Ms | null;
  /** 実測ROM / キャリブレーションROM。1.0 が理想。 */
  readonly romRatio: number;
  /** レップ中に到達した正規化信号のピーク値。 */
  readonly peak: number;
  /** レップ中の最低キーポイント score（非CVソースでは 1）。 */
  readonly minScore: number;
  readonly side: ArmSide;
  readonly valid: boolean;
  /** valid が false のとき非空。複数同時に成立しうる。 */
  readonly rejects: readonly RejectReason[];
}

/**
 * RepDetector に渡す前の、1フレーム分の正規化スカラ信号。M4 の SignalExtractor
 * （elbow-angle / wrist-height）が生成する。ここに置くのは、M3 の calibration.ts /
 * rep-detector.ts が M4 の signal.ts より先に必要とするため（signal.ts 自体は
 * この型を実装するだけで、定義はしない）。
 */
export interface SignalSample {
  readonly at: Ms;
  /** 生スカラ値（角度[deg] または上腕長で正規化した高さ）。単位は SignalKind に依存する。 */
  readonly raw: number;
  /** この信号を構成するキーポイントの最小 score。非CVソースでは 1。 */
  readonly score: number;
}

/** 1点のランドマーク。ピクセル座標 + 信頼度。 */
export interface Landmark {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

/**
 * 1フレーム分の姿勢推定結果。M4 の SignalExtractor（core/detect/signal.ts）が
 * これを読んで SignalSample を作る。
 *
 * ★ core/ 純粋性のための意図的な重複: sensors/pose/keypoints.ts にも同じ形の
 * PixelKeypoint 型と COCO index 定数があるが、あちらは pose-detection ライブラリの
 * 出力を正規化する「グルーコード」側の型で、こちらは core/ 内で完結させるための
 * 独立した型。pose-source.ts（sensors/ 側）が両者を変換して橋渡しする。
 */
export interface Landmarks {
  readonly at: Ms;
  /** COCO 17点、順序固定（0=nose, 5/6=肩, 7/8=肘, 9/10=手首, ...）。 */
  readonly kp: readonly Landmark[];
}
