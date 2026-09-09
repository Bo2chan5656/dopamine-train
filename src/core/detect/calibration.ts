import type { ArmSide, CameraView, SignalKind, SignalSample } from '../types';
import { JOINT_NAMES, type ArmProbe, type FrameProbe, type JointName, type JointValues } from './signal';

export interface CalibrationSample {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  /**
   * ★ 受理判定に使う score。**最小値ではなく下位10パーセンタイル**。
   *
   * かつて最小値を使っていたが、それは実質的に不合格を強制していた。1秒×24fps の
   * 記録に対して「全フレーム × 3キーポイントすべてが閾値以上」を要求することになり、
   * 1フレームでも手首の信頼度が落ちた瞬間に全部やり直しになる。仮に1フレームが
   * 基準を満たす確率が95%でも、24フレーム全部通る確率は 0.95^24 ≒ 29% しかない
   * （＝7割失敗する。しかも記録時間を延ばすと失敗率が上がるという逆向きの性質）。
   * p10 なら「24フレーム中2〜3フレームの取りこぼしは許す」になる。
   *
   * raw 値の代表値に p10/p50/p90 を使う設計判断（外れ値1フレームに引きずられない）が
   * score にだけ適用されていなかった、という一貫性の欠落でもある。
   */
  readonly scoreP10: number;
  /** 診断表示用の最小 score。判定には使わない。 */
  readonly scoreMin: number;
  readonly frames: number;
}

/**
 * キャリブレーション1ステップ（下端 or 上端）の記録結果。
 * 両腕を同時に測るので、どちらの腕を使うかを後から選べる。
 */
/**
 * 関節ごとの内訳。「体がよく見えていません」の原因を特定するためだけに存在する。
 *
 * ★ SignalSample.score は min(肩,肘,手首) に潰れているので、集約値だけ見ても
 * どの関節が足を引っ張っているのか分からない。手首なのか肩なのかで対処
 * （距離 / 画角の上下 / 袖の色）が全く違うため、必ず分解して見せる。
 */
export interface JointBreakdown {
  /** 関節ごとの score の p10。判定に使うのと同じ統計量。 */
  readonly scoreP10: JointValues;
  /** 記録中にその関節が画面端/画面外にいたフレームの割合（0..1）。 */
  readonly outsideRatio: JointValues;
}

export interface ArmCapture {
  readonly left: CalibrationSample;
  readonly right: CalibrationSample;
  /** 左腕の関節別内訳。 */
  readonly leftJoints: JointBreakdown;
  /** 右腕の関節別内訳。 */
  readonly rightJoints: JointBreakdown;
  /** 肩幅/上腕長。カメラに対する体の向きの指標（signal.ts の FrameProbe 参照）。 */
  readonly shoulderRatio: CalibrationSample;
  /** 上腕長（ピクセル）。距離・フレーミングの診断用。 */
  readonly armLenPx: CalibrationSample;
  /** 姿勢が取れなかった（＝代表値の計算に入れなかった）フレーム数。診断用。 */
  readonly droppedFrames: number;
}

export interface Calibration {
  readonly signal: SignalKind;
  /** ★ 宣言ではなく「両腕を測って良い方を選んだ結果」。 */
  readonly side: ArmSide;
  /** ★ 宣言ではなく「肩幅/上腕長から推定した実際の向き」。 */
  readonly view: CameraView;
  /**
   * 伸展側（下端）の代表値。符号の向きは signal ごとに異なる:
   *   - elbow-angle:   伸展で角度が大きい → bottomRaw > topRaw
   *   - wrist-height:  (肩y − 手首y)/上腕長。画像のyは下向き正なので、
   *                    腕を下げている(手首が肩より下＝手首yが大きい)ほど値は負に大きく、
   *                    curl して手首が肩に近づく/上がるほど値は増える → topRaw > bottomRaw
   * normalize() はこの向きに依存しない（単純な逆線形補間）が、
   * isCorrectDirection() の判定はこの向きを知っている必要がある。
   */
  readonly bottomRaw: number;
  readonly topRaw: number; // 屈曲側（上端）の代表値
  /**
   * 記録時の上腕長（診断用ピクセル値。例: dev panel に表示する）。
   * ★ ROM チェックには使わない — wrist-height の raw 値は
   * 「(肩y-手首y)/armLenPx」の時点で既に上腕長で割った比率になっているため、
   * ここでもう一度 armLenPx を掛けると二重に正規化してしまう。
   */
  readonly armLenPx: number;
  readonly createdAt: number; // Date.now()
}

export type CalibrationRejectReason =
  | 'rom_too_small'
  | 'low_confidence'
  | 'inverted'
  /** そもそも人物が映っていない（記録フレームがほとんど取れなかった）。 */
  | 'no_frames';

const MIN_FRAMES_FOR_SUMMARY = 3;
/**
 * キャリブレーションが要求するキーポイント信頼度（score の p10）。
 *
 * ★ 0.5 から 0.35 に下げた。0.5 は**通った後に走る検出器より厳しい**という矛盾が
 * あった（rep-detector の minScore は 0.3 でフレームを捨て、0.5 は単なる warnScore）。
 * 入口が出口より厳しいと、キャリブレーションは通らないのに通れば動く、という
 * おかしな状態になる。調査時点の推奨も「角度計算に使う3点すべてに 0.30〜0.35」
 * （MoveNet 内部の閾値が DEFAULT_MIN_POSE_SCORE=0.25 / MIN_CROP_KEYPOINT_SCORE=0.2）
 * であり、0.5 は根拠なく厳しく置いた値だった。
 */
const MIN_SCORE_FOR_CALIBRATION = 0.35;
const MIN_ROM_DEGREES = 60; // elbow-angle: |top - bottom| >= 60°
// wrist-height: raw は既に「上腕長に対する比率」なので、しきい値も比率のまま（
// armLenPx を掛け直さない）。|top - bottom| >= 0.8 本分の上腕長分は動いていること。
const MIN_ROM_ARM_LENGTH_RATIO = 0.8;

/**
 * 肩幅/上腕長 から体の向きを分類するしきい値。
 *
 * ★ この2つの値は実機で未検証。おおよその見積りは
 * 「肩幅(両肩峰間)≒40cm、上腕≒30cm → 正面で比 ≒ 1.3、45度で 1.3*cos45° ≒ 0.9、
 *  真横で ≒ 0」だが、MoveNet が肩をどこに置くかで変わるので実測で詰める必要がある。
 *
 * ★ したがって**この分類で受理を拒否しない**（警告のみ）。しきい値がずれていたら
 * 正しく45度に立っているのに永久に通らなくなってしまう。実際のゲートは物理的に
 * 意味がある ROM と信頼度の2つに任せる。
 */
const SHOULDER_RATIO_FRONT = 1.1;
const SHOULDER_RATIO_SIDE = 0.35;

/** 肩幅/上腕長 → 体の向き。値が取れない場合（NaN）は side45 とみなす。 */
export function classifyView(shoulderRatio: number): CameraView {
  if (!Number.isFinite(shoulderRatio)) return 'side45';
  if (shoulderRatio >= SHOULDER_RATIO_FRONT) return 'front';
  if (shoulderRatio <= SHOULDER_RATIO_SIDE) return 'side';
  return 'side45';
}

/**
 * 1秒窓のサンプル列 → ロバストな代表値。min/max ではなく p10/p50/p90（percentile）を
 * 使う — 一瞬の誤検出フレーム1つに代表値が引きずられないようにするため。
 */
export function summarize(samples: readonly SignalSample[]): CalibrationSample {
  if (samples.length === 0) {
    return { p10: NaN, p50: NaN, p90: NaN, scoreP10: 0, scoreMin: 0, frames: 0 };
  }
  // map() は新しい配列を返すので、元の samples を破壊せずそのまま sort() してよい。
  const raws = samples.map((s) => s.raw).sort((a, b) => a - b);
  const scores = samples.map((s) => s.score).sort((a, b) => a - b);
  return {
    p10: percentile(raws, 0.1),
    p50: percentile(raws, 0.5),
    p90: percentile(raws, 0.9),
    scoreP10: percentile(scores, 0.1),
    scoreMin: scores[0]!,
    frames: samples.length,
  };
}

/** 数値列（score を持たない指標: 肩幅比・上腕長）を CalibrationSample 形に集約する。 */
function summarizeValues(values: readonly number[]): CalibrationSample {
  return summarize(values.map((raw) => ({ at: 0, raw, score: 1 })));
}

/**
 * キャリブレーション記録中の FrameProbe 列 → ArmCapture。
 *
 * ★ 呼び出し側（pose-source）は「姿勢が取れたフレームだけ」を probes に入れること。
 * 姿勢が取れなかったフレームは欠測であって観測値ではないので、代表値に混ぜてはいけない
 * （かつて score:0 のダミーサンプルが混入し、1フレーム落ちるだけで
 * low_confidence 確定になるバグの原因になっていた）。落ちた数は droppedFrames で受ける。
 */
export function summarizeCapture(probes: readonly FrameProbe[], droppedFrames: number): ArmCapture {
  const pick = (get: (p: FrameProbe) => SignalSample | null): CalibrationSample =>
    summarize(probes.map(get).filter((s): s is SignalSample => s !== null));

  const numeric = (get: (p: FrameProbe) => number | null): CalibrationSample =>
    summarizeValues(probes.map(get).filter((v): v is number => v !== null));

  /** 関節ごとに score の p10 と「画面端/画面外だったフレームの割合」を出す。 */
  const breakdown = (get: (p: FrameProbe) => ArmProbe): JointBreakdown => {
    const arms = probes.map(get);
    return {
      scoreP10: jointStat(arms, 'scores', (v) => percentile(v, 0.1)),
      outsideRatio: jointStat(arms, 'outside', (v) => v.reduce((a, b) => a + b, 0) / v.length),
    };
  };

  return {
    left: pick((p) => p.left.sample),
    right: pick((p) => p.right.sample),
    leftJoints: breakdown((p) => p.left),
    rightJoints: breakdown((p) => p.right),
    shoulderRatio: numeric((p) => p.shoulderRatio),
    armLenPx: numeric((p) => p.armLenPx),
    droppedFrames,
  };
}

/** ArmProbe 列から、関節ごとに指定の統計量を計算する。 */
function jointStat(
  arms: readonly ArmProbe[],
  field: 'scores' | 'outside',
  reduce: (sortedAsc: number[]) => number,
): JointValues {
  const out: Record<JointName, number> = { shoulder: 0, elbow: 0, wrist: 0 };
  for (const joint of JOINT_NAMES) {
    const values = arms.map((a) => a[field][joint]);
    out[joint] = values.length === 0 ? 0 : reduce([...values].sort((a, b) => a - b));
  }
  return out;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  const last = sortedAsc.length - 1;
  if (last === 0) return sortedAsc[0]!;
  const idx = p * last;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sortedAsc[lo]!;
  if (lo === hi) return loVal;
  const hiVal = sortedAsc[hi]!;
  return loVal + (hiVal - loVal) * (idx - lo);
}

/** 0 = 下端, 1 = 上端。範囲外は [-0.5, 1.5] にクランプする（信号方向に依存しない逆線形補間）。 */
export function normalize(raw: number, cal: Calibration): number {
  const span = cal.topRaw - cal.bottomRaw;
  if (span === 0) return 0.5; // 壊れたキャリブレーション。resolveCalibration で弾かれているはず
  const v = (raw - cal.bottomRaw) / span;
  return Math.max(-0.5, Math.min(1.5, v));
}

/** normalize() の逆演算。テスト用の合成信号生成や、設定画面の閾値プレビュー等に使う。 */
export function denormalize(norm: number, cal: Calibration): number {
  return cal.bottomRaw + norm * (cal.topRaw - cal.bottomRaw);
}

function isCorrectDirection(signal: SignalKind, bottomRaw: number, topRaw: number): boolean {
  // signal ごとの符号の向きは Calibration の doc comment を参照。
  return signal === 'elbow-angle' ? bottomRaw > topRaw : topRaw > bottomRaw;
}

function minRomFor(signal: SignalKind): number {
  return signal === 'elbow-angle' ? MIN_ROM_DEGREES : MIN_ROM_ARM_LENGTH_RATIO;
}

// ---------------------------------------------------------------------------
// 受理条件と左右の自動選択
//
// ★ 受理条件（信頼度 / ROM / 向き）の実装はこの下の buildCandidate ＋
// resolveCalibration の1箇所だけにある。かつて validateCalibration() という
// 単一キャリブレーション向けの検証関数も持っていたが、同じルールが2箇所に
// 書かれる形になったので削除した（片方だけ直して食い違うのが目に見えている）。
//
// ここが実質的な「唯一の不正対策」— 手首をちょこちょこ振る動きで上端/下端を
// 登録すれば、正規化後は完璧なフルレップに見えてしまうため、ここで ROM の絶対量と
// 信頼度を担保する。これを塞げば下流（validity.ts）の ROM チェックはほぼ自動的に
// 満たされる。
// ---------------------------------------------------------------------------

/** 片腕分の候補と、各ゲートの通過状況。ウィザードの診断表示にそのまま使う。 */
export interface ArmCandidate {
  readonly side: 'left' | 'right';
  readonly bottomRaw: number;
  readonly topRaw: number;
  readonly rom: number;
  readonly scoreP10: number;
  readonly frames: number;
  readonly confidenceOk: boolean;
  readonly romOk: boolean;
  readonly directionOk: boolean;
}

/**
 * 関節1つ分の診断行。ウィザードがそのまま表として描く。
 * 「体がよく見えていません」が出たときに、どの関節・どちらの記録が原因かを
 * 数字で示すためのもの。
 */
export interface JointDiagnosticRow {
  readonly side: 'left' | 'right';
  readonly joint: JointName;
  /** 下端記録での score p10。 */
  readonly bottomScoreP10: number;
  /** 上端記録での score p10。 */
  readonly topScoreP10: number;
  /** 下端・上端のうち悪い方の「画面端/画面外だったフレームの割合」（0..1）。 */
  readonly outsideRatio: number;
  /** この関節が信頼度の足を引っ張っているか（両記録の悪い方が閾値未満）。 */
  readonly isBottleneck: boolean;
}

export interface CalibrationDiagnostics {
  readonly candidates: readonly ArmCandidate[];
  /** 関節別の内訳（左右×肩肘手首の6行）。信頼度不足の原因特定に使う。 */
  readonly joints: readonly JointDiagnosticRow[];
  /** 受理に必要な score の下限。ウィザードが「0.35 未満が原因」と示すために使う。 */
  readonly minScore: number;
  /** 推定した体の向き（受理判定には使わない。警告表示用）。 */
  readonly view: CameraView;
  readonly shoulderRatio: number;
  /** 上腕長の中央値（ピクセル）。小さすぎたら遠すぎる合図。 */
  readonly armLenPx: number;
  readonly droppedFrames: number;
}

export type CalibrationResolution =
  | { readonly ok: true; readonly calibration: Calibration; readonly diagnostics: CalibrationDiagnostics }
  | {
      readonly ok: false;
      readonly reason: CalibrationRejectReason;
      readonly diagnostics: CalibrationDiagnostics;
    };

function buildCandidate(
  signal: SignalKind,
  side: 'left' | 'right',
  bottom: CalibrationSample,
  top: CalibrationSample,
): ArmCandidate {
  const rom = Math.abs(top.p50 - bottom.p50);
  const frames = Math.min(bottom.frames, top.frames);
  const scoreP10 = Math.min(bottom.scoreP10, top.scoreP10);
  return {
    side,
    bottomRaw: bottom.p50,
    topRaw: top.p50,
    rom: Number.isFinite(rom) ? rom : 0,
    scoreP10,
    frames,
    confidenceOk: frames >= MIN_FRAMES_FOR_SUMMARY && scoreP10 >= MIN_SCORE_FOR_CALIBRATION,
    romOk: Number.isFinite(rom) && rom >= minRomFor(signal),
    directionOk: isCorrectDirection(signal, bottom.p50, top.p50),
  };
}

/**
 * 下端・上端の記録から「どちらの腕でキャリブレーションするか」を決めて Calibration を組む。
 *
 * ★ これが「カメラを左右どちらの斜め45度に置いても使える」ようにする中核。
 * 使う腕を宣言させる代わりに、両腕を測って
 *   1. 信頼度が足りている
 *   2. ROM が足りている
 *   3. 向き（伸展→屈曲）が正しい
 * の3つを満たす候補のうち **ROM が最大のもの** を選ぶ。カメラに近い腕は
 * よく見えて可動域も大きく写り、奥の腕は体に隠れて信頼度が落ちるか、
 * そもそも動かしていなければ ROM が出ない — 結果として「カメラに近い側の、
 * 実際に動かした腕」が自動的に選ばれる。
 *
 * 失敗理由は「最も先のゲートまで進んだ候補」に合わせる（信頼度は足りているのに
 * ROM が小さい、なら "もっと大きく動かして" が正しい助言になる）。
 */
export function resolveCalibration(
  signal: SignalKind,
  bottom: ArmCapture,
  top: ArmCapture,
  nowWall: number,
): CalibrationResolution {
  const candidates = [
    buildCandidate(signal, 'left', bottom.left, top.left),
    buildCandidate(signal, 'right', bottom.right, top.right),
  ];

  const shoulderRatio = (bottom.shoulderRatio.p50 + top.shoulderRatio.p50) / 2;
  const armLenPx = (bottom.armLenPx.p50 + top.armLenPx.p50) / 2;

  const joints: JointDiagnosticRow[] = [];
  for (const side of ['left', 'right'] as const) {
    const b = side === 'left' ? bottom.leftJoints : bottom.rightJoints;
    const t = side === 'left' ? top.leftJoints : top.rightJoints;
    for (const joint of JOINT_NAMES) {
      const bottomScoreP10 = b.scoreP10[joint];
      const topScoreP10 = t.scoreP10[joint];
      joints.push({
        side,
        joint,
        bottomScoreP10,
        topScoreP10,
        outsideRatio: Math.max(b.outsideRatio[joint], t.outsideRatio[joint]),
        isBottleneck: Math.min(bottomScoreP10, topScoreP10) < MIN_SCORE_FOR_CALIBRATION,
      });
    }
  }

  const diagnostics: CalibrationDiagnostics = {
    candidates,
    joints,
    minScore: MIN_SCORE_FOR_CALIBRATION,
    view: classifyView(shoulderRatio),
    shoulderRatio,
    armLenPx: Number.isFinite(armLenPx) ? armLenPx : 0,
    droppedFrames: bottom.droppedFrames + top.droppedFrames,
  };

  const passed = candidates.filter((c) => c.confidenceOk && c.romOk && c.directionOk);
  const best = passed.reduce<ArmCandidate | null>((a, c) => (a === null || c.rom > a.rom ? c : a), null);

  if (best) {
    return {
      ok: true,
      diagnostics,
      calibration: {
        signal,
        side: best.side,
        view: diagnostics.view,
        bottomRaw: best.bottomRaw,
        topRaw: best.topRaw,
        armLenPx: diagnostics.armLenPx,
        createdAt: nowWall,
      },
    };
  }

  // 到達できた一番先のゲートを理由にする（助言が具体的になる順）。
  if (candidates.every((c) => c.frames < MIN_FRAMES_FOR_SUMMARY)) {
    return { ok: false, reason: 'no_frames', diagnostics };
  }
  const confident = candidates.filter((c) => c.confidenceOk);
  if (confident.length === 0) {
    return { ok: false, reason: 'low_confidence', diagnostics };
  }
  if (confident.some((c) => c.directionOk)) {
    return { ok: false, reason: 'rom_too_small', diagnostics };
  }
  // 向きが合っている候補が1つも無い = 伸展/屈曲を逆に記録した、または違う腕を動かした
  return { ok: false, reason: confident.some((c) => c.romOk) ? 'inverted' : 'rom_too_small', diagnostics };
}
