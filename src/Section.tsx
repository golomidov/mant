import type { ReactNode } from 'react'

type SectionProps = { title: string; meta?: ReactNode; className?: string; children: ReactNode; onToggle?(open: boolean): void }

export function Section({ title, meta, className = '', children, onToggle }: SectionProps) {
  return <details className={`section ${className}`} name="workspace-panels" onToggle={event => { if (event.target === event.currentTarget) onToggle?.(event.currentTarget.open) }}>
    <summary className="section-heading"><h2>{title}</h2>{meta && <span className="section-meta">{meta}</span>}</summary>
    <div className="section-body">{children}</div>
  </details>
}

export function Column({ title, meta, className = '', children }: SectionProps) {
  return <section className={`section workspace-column ${className}`} aria-label={title}>
    <div className="section-heading"><h2>{title}</h2>{meta && <span className="section-meta">{meta}</span>}</div>
    <div className="section-body">{children}</div>
  </section>
}
