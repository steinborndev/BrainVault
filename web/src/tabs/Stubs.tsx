/**
 * Wartung/Maintenance (SPEC.md §6.4) is still M4 work-in-progress. The Query/Chat tab is
 * live (tabs/Chat.tsx); this remains a placeholder until the lint/autoresearch/hot-cache
 * controls land.
 */

export function MaintenanceStub(): React.ReactElement {
  return (
    <div className="stub">
      <div className="icon">🛠️</div>
      <h2>Wartung</h2>
      <p>
        Lint-Report, Autoresearch und Hot-Cache-Refresh. Kommt in Milestone&nbsp;4; die
        Einstellungen folgen in&nbsp;M5.
      </p>
    </div>
  )
}
