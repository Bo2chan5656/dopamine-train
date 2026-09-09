import type { CreditLedger } from '../credit/ledger';
import type { CreditPolicy } from '../credit/policy';
import type { Ms, RejectReason } from '../types';
// 型のみの import。verbatimModuleSyntax によりランタイムコードは一切生成されない
// ので、core/ の「DOM 依存ゼロ」原則は破れない（RepSource/Slider の実装が window や
// <video> に触れていても、ここでは型情報だけを見ている）。
import type { RepSource } from '../../sensors/rep-source';
import type { Slider } from '../../slider/slider';

export interface HudViewModel {
  readonly balanceSeconds: number;
  readonly pendingReps: number;
  readonly neededReps: number;
  readonly todayReps: number;
  readonly dailyRepCap: number;
  readonly locked: boolean;
  /** 直近の無効レップの理由。日本語化は ui/hud.ts 側の責務。 */
  readonly lastRejectReasons: readonly RejectReason[];
}

/** UI 実装を core から隠す最小ポート。ui/hud.ts がこれを実装する。 */
export interface HudPort {
  update(vm: HudViewModel): void;
}

/** ui/sound.ts がこれを実装する。 */
export interface SoundPort {
  rep(): void;
  invalid(): void;
  low(): void;
  depleted(): void;
}

/** M1 時点では設定＝報酬設計のみ。腕/ビュー/検出閾値は M4-M5 で拡張する。 */
export interface Settings {
  readonly credit: CreditPolicy;
}

export interface SessionControllerDeps {
  readonly source: RepSource;
  readonly ledger: CreditLedger;
  readonly slider: Slider;
  readonly hud: HudPort;
  readonly sound: SoundPort;
  readonly settings: Settings;
  /** テスト用に注入する壁時計。Date.now 相当の関数だけを提供する。 */
  readonly clock: { wall(): number };
}

/**
 * RepSource / CreditLedger / Slider を結線するアプリの中核。
 *
 * ★ core/ の一員なので DOM / localStorage / requestAnimationFrame には一切触れない。
 * rAF ループの駆動とタブ可視性の判定は main.ts（ブラウザの入口）の責務であり、ここでは
 * `tick(now, isVisible)` として「時刻と可視性を値として受け取るだけ」にする。これにより
 * vitest の environment:'node' でも各メソッドを直接呼んでユニットテストできる。
 *
 * M1 時点ではまだ session-machine.ts の状態遷移表（M2）を使わない。ここでの
 * play/pause/lock の決定は「ledger のイベントに反応する」単純なルールで十分なため。
 */
export class SessionController {
  private readonly unsubscribes: Array<() => void> = [];
  private lastRejectReasons: readonly RejectReason[] = [];
  private lastTickAt: Ms | null = null;
  private lastRefreshAt: Ms = 0;

  constructor(private readonly deps: SessionControllerDeps) {}

  start(): void {
    const { source, ledger, slider } = this.deps;

    this.unsubscribes.push(
      source.events.on('rep', (rep) => {
        this.lastRejectReasons = rep.valid ? [] : rep.rejects;
        if (rep.valid) this.deps.sound.rep();
        else this.deps.sound.invalid();
        ledger.creditRep(rep, this.deps.clock.wall());
        this.renderHud();
      }),
    );
    this.unsubscribes.push(
      ledger.events.on('granted', () => {
        this.deps.sound.rep();
        slider.setLocked(false);
        if (!slider.isPlaying()) void slider.play();
        this.renderHud();
      }),
    );
    this.unsubscribes.push(
      ledger.events.on('low', () => {
        this.deps.sound.low();
        this.renderHud();
      }),
    );
    this.unsubscribes.push(
      ledger.events.on('depleted', () => {
        this.deps.sound.depleted();
        slider.setLocked(true, 'クレジットがありません。運動してください');
        void slider.pause('depleted');
        this.renderHud();
      }),
    );
    this.unsubscribes.push(ledger.events.on('changed', () => this.renderHud()));

    source.start();

    // リロード直後、復元された残高を即座にスライダー状態へ反映する。
    if (ledger.balanceSeconds > 0) {
      slider.setLocked(false);
      void slider.play();
    } else {
      slider.setLocked(true, 'クレジットがありません。運動してください');
    }
    this.renderHud();
  }

  /**
   * このコントローラインスタンスの購読解除のみ行う。★ source.stop() は呼ばない —
   * 設定（credit policy）変更のたびに main.ts が「古い controller を stop して
   * 新しい controller を start する」という配線をしており、ここで source.stop()
   * まで呼ぶと、webcam-movenet の場合カメラが毎回停止・再取得されてしまう
   * （keyboard-source 等では無害だったため M1 では気づかなかった実際のバグ）。
   * source（カメラ）自体のライフサイクル管理は呼び出し側の責務にする。
   */
  stop(): void {
    for (const off of this.unsubscribes.splice(0)) off();
  }

  /** main.ts の rAF ループから毎フレーム呼ばれる。副作用は ledger.consume/refresh のみ。 */
  tick(now: Ms, isVisible: boolean): void {
    const { ledger, slider, clock } = this.deps;
    const dt = this.lastTickAt === null ? 0 : now - this.lastTickAt;
    this.lastTickAt = now;

    // dt<=0（初回）や dt>=1000（タブ復帰直後の巨大ギャップ）は消費に使わない。
    // 後者を弾かないと、バックグラウンドで放置していた分を復帰の瞬間に一気に
    // 溶かしてしまう（latest-wins ではなく "catch-up" が起きる）。
    if (isVisible && slider.isPlaying() && dt > 0 && dt < 1000) {
      ledger.consume(dt, clock.wall());
    }
    if (now - this.lastRefreshAt > 1000) {
      ledger.refresh(clock.wall());
      this.lastRefreshAt = now;
    }
  }

  private renderHud(): void {
    const { ledger, settings } = this.deps;
    this.deps.hud.update({
      balanceSeconds: ledger.balanceSeconds,
      pendingReps: ledger.pendingReps,
      neededReps: settings.credit.repsPerGrant,
      todayReps: ledger.todayReps,
      dailyRepCap: settings.credit.dailyRepCap,
      locked: ledger.balanceSeconds <= 0,
      lastRejectReasons: this.lastRejectReasons,
    });
  }
}
