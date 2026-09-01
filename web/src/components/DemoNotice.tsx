/**
 * Full-screen placeholder for a feature that is switched off on a hosted read-only demo
 * instance (SPEC.md §12.8). The tab stays visible so visitors see the feature exists;
 * this panel explains why it does not run here and where the full app lives.
 */

export function DemoNotice({ title, text }: { title: string; text: string }): React.ReactElement {
  return (
    <div className="empty" role="status">
      <h2>{title}</h2>
      <p className="qs-line">{text}</p>
      <p className="qs-line">
        This feature is not available in the hosted demo -{' '}
        <a href="https://github.com/steinborndev/BrainVault" target="_blank" rel="noreferrer">
          run BrainVault locally
        </a>{' '}
        to use it.
      </p>
    </div>
  )
}
