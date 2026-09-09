import { clampPolicy, type CreditPolicy } from '../core/credit/policy';
import './styles/settings.css';

export interface SettingsPanelOptions {
  readonly initial: CreditPolicy;
  readonly onChange: (policy: CreditPolicy) => void;
}

interface Fields {
  readonly repsPerGrant: HTMLInputElement;
  readonly secondsPerGrant: HTMLInputElement;
  readonly maxBankedSeconds: HTMLInputElement;
  readonly creditExpiryMinutes: HTMLInputElement;
  readonly dailyRepCap: HTMLInputElement;
  readonly lowWarningSeconds: HTMLInputElement;
}

/**
 * M1 時点では credit（N/X/貯蓄上限/失効/日次上限/低残量警告）だけを扱う。
 * 腕/ビュー/検出閾値は M4-M5 で core/session/controller.ts の Settings が
 * 拡張されたタイミングで、このパネルにもフィールドを追加する。
 */
export function createSettingsPanel(root: HTMLElement, opts: SettingsPanelOptions): void {
  const form = document.createElement('form');
  form.className = 'dt-settings';
  form.innerHTML = `
    <fieldset>
      <legend>報酬設定</legend>
      <label>N（レップ/付与）<input type="number" name="repsPerGrant" min="1" max="100" /></label>
      <label>X（付与秒数）<input type="number" name="secondsPerGrant" min="1" max="3600" /></label>
      <label>貯蓄上限（秒）<input type="number" name="maxBankedSeconds" min="0" max="86400" /></label>
      <label>失効まで（分）<input type="number" name="creditExpiryMinutes" min="1" max="1440" /></label>
      <label>日次上限（レップ）<input type="number" name="dailyRepCap" min="0" max="10000" /></label>
      <label>低残量警告（秒）<input type="number" name="lowWarningSeconds" min="0" max="3600" /></label>
    </fieldset>
  `;
  root.appendChild(form);

  function query(name: string): HTMLInputElement {
    const el = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!el) throw new Error(`settings-panel: missing field "${name}"`);
    return el;
  }

  const fields: Fields = {
    repsPerGrant: query('repsPerGrant'),
    secondsPerGrant: query('secondsPerGrant'),
    maxBankedSeconds: query('maxBankedSeconds'),
    creditExpiryMinutes: query('creditExpiryMinutes'),
    dailyRepCap: query('dailyRepCap'),
    lowWarningSeconds: query('lowWarningSeconds'),
  };

  function setFields(policy: CreditPolicy): void {
    fields.repsPerGrant.value = String(policy.repsPerGrant);
    fields.secondsPerGrant.value = String(policy.secondsPerGrant);
    fields.maxBankedSeconds.value = String(policy.maxBankedSeconds);
    fields.creditExpiryMinutes.value = policy.creditExpiryMs === null ? '' : String(policy.creditExpiryMs / 60_000);
    fields.dailyRepCap.value = String(policy.dailyRepCap);
    fields.lowWarningSeconds.value = String(policy.lowWarningSeconds);
  }
  setFields(opts.initial);

  form.addEventListener('input', () => {
    const expiryMinutes = fields.creditExpiryMinutes.value.trim();
    const patch: Partial<CreditPolicy> = {
      repsPerGrant: Number(fields.repsPerGrant.value),
      secondsPerGrant: Number(fields.secondsPerGrant.value),
      maxBankedSeconds: Number(fields.maxBankedSeconds.value),
      creditExpiryMs: expiryMinutes === '' ? null : Number(expiryMinutes) * 60_000,
      dailyRepCap: Number(fields.dailyRepCap.value),
      lowWarningSeconds: Number(fields.lowWarningSeconds.value),
    };
    const clamped = clampPolicy(patch);
    setFields(clamped); // クランプで値が変わったら入力欄に snap back させる
    opts.onChange(clamped);
  });
}
