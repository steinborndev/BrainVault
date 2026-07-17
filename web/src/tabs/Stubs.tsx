/**
 * Query/Chat (SPEC.md §6.3) and Wartung/Maintenance (SPEC.md §6.4) are M4 work. M3 ships
 * the 4-tab shell with these as visible placeholders — wired, not walled off (TASKS-M3 §2).
 */

export function ChatStub(): React.ReactElement {
  return (
    <div className="stub">
      <div className="icon">💬</div>
      <h2>Query &amp; Chat</h2>
      <p>
        Frage den Vault in natürlicher Sprache — mit klickbaren Quellenangaben zu den
        Wiki-Seiten. Kommt in Milestone&nbsp;4.
      </p>
    </div>
  )
}

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
