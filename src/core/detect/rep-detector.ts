import { OneEuroFilter, type OneEuroConfig } from '../filter/one-euro';
import type { ArmSide, Ms, RepEvent, RepPhase, SignalSample, TrackingState } from '../types';
import { normalize, type Calibration } from './calibration';
import { evaluateRejects } from './validity';

export interface DetectorConfig {
  readonly topThreshold: number; // 既定 0.80  ★invariant: bottomThreshold + 0.3 <= topThreshold
  readonly bottomThreshold: number; // 既定 0.20
  /**
   * 挙上の最短時間。★意味は「下端ゾーン(bottomThreshold)を出てから上端に到達するまで」。
   *
   * かつては「下端ゾーンに入ってから上端に到達するまで」だった。連続的な往復運動では
   * それが真の挙上時間に近い値になる（周期1500msの正弦なら 750ms）が、下端で休むと
   * 休憩時間まで含まれてしまい、4秒以上休むと次のレップが必ず too_slow になるという
   * バグの原因だった（per-slide 方式では1レップごとに動画を30秒見る＝下端で30秒休むので
   * 致命的）。定義を「下端ゾーンを出てから」に変えて休憩時間の混入を無くした。
   *
   * その代わり測る区間が 0.2→0.8 の通過時間だけになり、同じ動作でも値が小さくなる
   * （周期1500msの正弦で 750ms → 307ms）。したがって既定値も 400 から下げてある。
   * 180ms は「周期880msより速い往復を弾く」に相当し、それより速いのは反動を使った
   * 振り回しとみなせる。チャタリング（閾値近傍の振動）はそもそも 0.2→0.8 を
   * 通過できないので、この値に依存せず弾かれる。
   */
  readonly minConcentricMs: Ms; // 既定 180
  readonly maxConcentricMs: Ms; // 既定 4000
  readonly minEccentricMs: Ms; // 既定 500  ← テンポゲート＝速度上限の実体
  readonly minInterRepMs: Ms; // 既定 500
  readonly minRomRatio: number; // 既定 0.70
  readonly minScore: number; // 既定 0.30  フレーム破棄の閾値
  /**
   * これを下回るフレームが1枚でもレップ中にあると 'low_confidence' で無効にする。
   *
   * ★ 0.5 から 0.35 に下げた。キャリブレーションの受理ゲート
   * （MIN_SCORE_FOR_CALIBRATION = 0.35）より厳しいと、
   * **キャリブレーションは通るのに運動すると全レップ弾かれる**という矛盾になる。
   * 実機の実測でキーポイント score の p10 が 0.43-0.45 だったため、0.5 では
   * 平常時から下回っており、ほぼ全レップが無効になっていた。
   */
  readonly warnScore: number; // 既定 0.35
  readonly lostAfterMs: Ms; // 既定 700
  readonly filterResetGapMs: Ms; // 既定 300
  readonly filter: OneEuroConfig;
}

/**
 * 既定の検出設定。★「取りこぼさないこと」を優先して緩めた profile。
 *
 * 実機で「実際に挙げてもカウントされないのが大半」という状態が続いたため、
 * 精度よりも確実性を採る方針に切り替えた。緩めた項目と理由:
 *
 *  - topThreshold 0.80 → 0.75 / bottomThreshold 0.20 → 0.25
 *      端への到達を必要とする幅を 60% → 50% に縮めた。キャリブレーション時の
 *      可動域より実際の動作が浅くなっても端に届く。
 *  - minRomRatio 0.70 → 0.40
 *      ★これは実質バグだった。romRatio は「上端到達時の値 − 谷の値」なので、
 *      構造上の最小値は topThreshold − bottomThreshold（旧設定で 0.6）。
 *      0.7 を要求していたため**ぎりぎり通過したレップは必ず short_rom で
 *      弾かれていた**（計画では no-op のはずだと書かれていた）。新しい閾値では
 *      構造上の最小が 0.5 なので、0.4 なら本当に no-op（保険）になる。
 *  - minScore 0.30 → 0.20 / warnScore 0.35 → 0.20
 *      MoveNet 内部の MIN_CROP_KEYPOINT_SCORE と同じ 0.2 まで下げた。
 *      warnScore を minScore と同値にしたので、**'low_confidence' は事実上
 *      発火しなくなる**（フレーム破棄を生き延びた時点で必ず minScore 以上）。
 *      信頼度の可視化は dev panel の関節別ライブ表示に任せる — 判定を止める
 *      よりも「見える化して本人が直す」ほうが実用的だと判断した。
 *  - lostAfterMs 700 → 1200
 *      一瞬見失っただけで進行中のレップを破棄しないようにした。
 *  - minConcentricMs 180 → 150
 *      閾値幅を縮めた分、通過時間も短くなるため合わせて下げた。
 *
 * ★ 緩めていない項目とその理由:
 *  - minEccentricMs 500 は**安全機構**。下ろす動作が速すぎる（重力任せ）のは
 *    肘の腱への衝撃そのものなので、カウントのために下げてはいけない。
 *  - minInterRepMs 500 はチャタリング（信号の振動を連続レップと誤認）の防止。
 *  - maxConcentricMs 4000 は上限側なので取りこぼしには寄与しない。
 *
 * ★ トレードオフ: 偽陽性（カールでない動きが数えられる）が増える。歩き回る・
 * 腕を振るだけで計上される可能性がある。「数えられないより数えられすぎるほうが
 * まし」という判断であり、精度を戻したい場合はこの表の値を元に戻せばよい。
 */
export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  topThreshold: 0.75,
  bottomThreshold: 0.25,
  minConcentricMs: 150,
  maxConcentricMs: 4000,
  minEccentricMs: 500, // ★安全機構。下げない
  minInterRepMs: 500,
  minRomRatio: 0.4,
  minScore: 0.2,
  warnScore: 0.2, // = minScore なので low_confidence は事実上出ない
  lostAfterMs: 1200,
  filterResetGapMs: 300,
  filter: { minCutoff: 1.0, beta: 1.0, dCutoff: 1.0 },
};

export type DetectorOutput =
  | { readonly type: 'progress'; readonly value: number; readonly phase: RepPhase }
  | { readonly type: 'rep'; readonly rep: RepEvent }
  | { readonly type: 'tracking'; readonly state: TrackingState }
  | {
      readonly type: 'diagnostic';
      readonly hint: DetectorDiagnosticHint;
      readonly observedMax: number;
      readonly observedMin: number;
    };

/**
 * 沈黙診断の種類。
 *
 * ★ 'bottom_unreachable' は後から足した。もともと「上端に届かない」だけを見ていたが、
 * 実機の信号グラフで**上端は超えているのに谷が 0.6 止まりで下端(0.2)に戻らない**
 * ケースを踏んだ。シュミットトリガは「下端に入ってから上端を超える」ことでレップを
 * 数えるので、下端に戻らなければレップは永久に0のまま。しかも旧診断の条件は
 * `sessionMax < topThreshold` だったため、この状況では**何の警告も出ない**という
 * 一番まずい沈黙が起きていた。
 */
export type DetectorDiagnosticHint = 'top_unreachable' | 'bottom_unreachable';

export interface DetectorState {
  readonly phase: RepPhase;
  readonly lost: boolean;
  readonly sessionMax: number;
  readonly sessionMin: number;
}

export interface RepDetector {
  /** ★副作用なし・時刻はサンプルから注入・I/Oなし。Date.now()/performance.now() を中で呼ばない。 */
  update(sample: SignalSample): DetectorOutput[];
  reset(): void;
  snapshot(): DetectorState;
}

const DIAG_SILENCE_MS = 15_000;
const DIAG_MIN_OBSERVED_MAX = 0.35;

/**
 * レップ検出のステートマシン本体。肘角度/手首高さいずれの信号でも、既に
 * normalize() 済みの 0..1 スカラを受け取る前提（信号非依存）。
 *
 * シュミットトリガ（2閾値ヒステリシス）+ One-Euro Filter + 信頼度ゲート + 沈黙診断。
 * レップは「上端到達の瞬間」に計上する（1周期の完了を待たない＝レイテンシが半分になる）。
 */
export function createRepDetector(cfg: DetectorConfig, cal: Calibration, side: ArmSide): RepDetector {
  const filter = new OneEuroFilter(cfg.filter);

  let phase: RepPhase = 'unknown';
  let lastT: Ms | null = null;
  let lowScoreSince: Ms | null = null;
  let lost = false;

  let bottomAt: Ms | null = null;
  let topAt: Ms | null = null;
  let trough = NaN;
  let peak = NaN;
  let repMinScore = 1;
  let pendingEccentricMs: Ms | null = null;

  let lastRepAt: Ms = -Infinity;
  let repId = 0;
  let sessionMax = 0;
  let sessionMin = 1;
  let lastRepOrDiagAt: Ms = -Infinity;

  function abortRep(): void {
    trough = NaN;
    peak = NaN;
    repMinScore = 1;
    bottomAt = null;
    topAt = null;
    pendingEccentricMs = null;
  }

  function enterBottom(t: Ms, xf: number): void {
    pendingEccentricMs = topAt !== null ? t - topAt : null;
    phase = 'at-bottom';
    bottomAt = t;
    trough = xf;
    peak = xf;
    repMinScore = 1;
  }

  function buildRep(t: Ms, xf: number): RepEvent {
    const concentricMs = bottomAt !== null ? t - bottomAt : 0;
    const romRatio = xf - trough;
    const rejects = evaluateRejects(
      {
        concentricMs,
        eccentricMs: pendingEccentricMs,
        romRatio,
        repMinScore,
        msSinceLastRep: t - lastRepAt,
      },
      cfg,
    );
    return {
      id: ++repId,
      at: t,
      concentricMs,
      eccentricMs: pendingEccentricMs,
      romRatio,
      peak: xf,
      minScore: repMinScore,
      side,
      valid: rejects.length === 0,
      rejects,
    };
  }

  function update(sample: SignalSample): DetectorOutput[] {
    const out: DetectorOutput[] = [];
    const t = sample.at;

    // (1) 信頼度ゲート — 低 score フレームは破棄する。フィルタに入れない、外挿も補間もしない。
    if (sample.score < cfg.minScore) {
      lowScoreSince ??= t;
      if (!lost && t - lowScoreSince >= cfg.lostAfterMs) {
        lost = true;
        abortRep(); // 進行中レップを破棄する
        out.push({ type: 'tracking', state: { kind: 'lost', sinceMs: lowScoreSince } });
      }
      return out;
    }
    if (lowScoreSince !== null && !lost) {
      // lostAfterMs に達する前に score が回復した（一瞬のブレ）。
      out.push({ type: 'tracking', state: { kind: 'ok', minScore: sample.score } });
    }
    lowScoreSince = null;

    if (lost) {
      // lostAfterMs を超えてから今回初めて回復した。★復帰直後は端に到達するまで数え始めない。
      lost = false;
      phase = 'unknown';
      filter.reset();
      out.push({ type: 'tracking', state: { kind: 'ok', minScore: sample.score } });
    }

    // (2) 正規化 → 平滑化
    const x = normalize(sample.raw, cal);
    if (lastT !== null && t - lastT > cfg.filterResetGapMs) {
      filter.reset(); // 長い欠測後は速度推定が壊れるのでリセットする
    }
    const xf = filter.filter(x, t / 1000);
    lastT = t;
    // ★沈黙診断の起点を最初の有効サンプルで打つ。-Infinity のままだと
    // 「t - (-Infinity) = Infinity > 15秒」が初回フレームから成立してしまい、
    // **1本目のレップの上昇中**（sessionMax が 0.35 を超えて 0.8 に届く前の一瞬）に
    // 誤診断が飛ぶ。pose-source が診断を捨てていた間は誰にも見えていなかったが、
    // HUD に配線した以上、運動開始直後に嘘の警告が出る実バグになる。
    if (lastRepOrDiagAt === -Infinity) lastRepOrDiagAt = t;

    sessionMax = Math.max(sessionMax, xf);
    sessionMin = Math.min(sessionMin, xf);

    out.push({ type: 'progress', value: clamp01(xf), phase });

    // (3) 累積の更新（このフレームに入ってきた時点の phase を使う。遷移は (4) で行う）
    repMinScore = Math.min(repMinScore, sample.score);
    if (phase === 'at-bottom') {
      trough = Math.min(trough, xf);
      peak = Math.max(peak, xf);
    }

    // (4) 遷移（シュミットトリガ）
    if (phase === 'unknown') {
      // 半端な位置から数え始めない: どちらかの端に入るまで待つ。
      if (xf <= cfg.bottomThreshold) {
        enterBottom(t, xf);
      } else if (xf >= cfg.topThreshold) {
        phase = 'at-top';
        topAt = t;
      }
    } else if (phase === 'at-bottom') {
      // ★下端ゾーンに留まっている間は「レップの起点」を打ち直す。
      //
      // concentricMs は「実際に持ち上げた時間」でなければならず、下端で休んでいた
      // 時間を含めてはいけない。これを直さないと per-slide 方式（1レップごとに動画を
      // 30秒見る＝下端で30秒休む）で2本目以降が必ず too_slow で無効になる。
      //
      // repMinScore も同じ理由でここでリセットする。あちらは「レップ中の最低
      // キーポイント信頼度」だが、下端の休憩を含めると**30秒のうち1フレーム
      // 落ちただけで次のレップが low_confidence になる**（＝「実際に挙げても
      // カウントされない」の主因）。測る範囲は挙上動作そのものに限る。
      if (xf <= cfg.bottomThreshold) {
        bottomAt = t;
        repMinScore = sample.score;
      }

      if (xf >= cfg.topThreshold) {
        // ★ここでレップ成立。1周期の完了を待たない。
        const rep = buildRep(t, xf);
        out.push({ type: 'rep', rep });
        phase = 'at-top';
        topAt = t;
        lastRepAt = t;
        lastRepOrDiagAt = t;
      }
    } else if (phase === 'at-top') {
      if (xf <= cfg.bottomThreshold) {
        enterBottom(t, xf); // 次のレップの起点。pendingEccentricMs = t - topAt を記録する。
      }
    }

    // (5) 沈黙診断 — 信号は動いているのにレップが出ない = どちらかの閾値に届いていない。
    // 黙ってゼロを出し続けない（これが無いと「カールしてるのに数が増えない、理由が
    // 分からない」でプロジェクトが死ぬ）。上端と下端の両方を見る。
    if (t - lastRepOrDiagAt > DIAG_SILENCE_MS && sessionMax > DIAG_MIN_OBSERVED_MAX) {
      const hint: DetectorDiagnosticHint | null =
        sessionMax < cfg.topThreshold
          ? 'top_unreachable'
          : sessionMin > cfg.bottomThreshold
            ? 'bottom_unreachable'
            : null;
      if (hint) {
        out.push({ type: 'diagnostic', hint, observedMax: sessionMax, observedMin: sessionMin });
        lastRepOrDiagAt = t;
        sessionMax = 0;
        sessionMin = 1;
      }
    }

    return out;
  }

  return {
    update,
    reset(): void {
      filter.reset();
      phase = 'unknown';
      lastT = null;
      lowScoreSince = null;
      lost = false;
      abortRep();
      lastRepAt = -Infinity;
      sessionMax = 0;
      sessionMin = 1;
      lastRepOrDiagAt = -Infinity;
    },
    snapshot(): DetectorState {
      return { phase, lost, sessionMax, sessionMin };
    },
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
