import { useId } from 'react'

type Option<T> = { value: T; label: string }

export function PillSwitch<T extends string | number>({ label, value, options, onChange, disabled = false, hideLabel = false }: { label: string; value: T; options: readonly Option<T>[]; onChange: (value: T) => void; disabled?: boolean; hideLabel?: boolean }) {
  const name = useId()
  return <fieldset className="pill-switch" disabled={disabled}>
    <legend className={hideLabel ? 'visually-hidden' : undefined}>{label}</legend>
    <div className="pill-options">{options.map(option => <label className="pill-option" key={option.value}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
      <span className="pill-label"><span className="pill-check" aria-hidden="true">{value === option.value ? '✓' : ''}</span>{option.label}</span>
    </label>)}</div>
  </fieldset>
}
