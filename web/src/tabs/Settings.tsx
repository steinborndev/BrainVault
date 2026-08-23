/**
 * Settings screen — configuration stands alone (redesign 2026-08). Everything here used to
 * live inside the Maintenance tab's "Expert tools" right column, which forced setup mode to
 * open the whole expert view just to reach the credential form. Now the app banner and
 * setup mode land here directly; Maintenance keeps only actual maintenance.
 */

import { SettingsEditor } from '../components/SettingsEditor.tsx'
import { Tip } from '../components/Tip.tsx'

export function Settings(): React.ReactElement {
  return (
    <div className="settings-lane">
      <div className="card card-pad">
        <div className="section-head">
          <h3 className="section-title">
            Settings
            <Tip text="Values from the environment are the baseline; values set here override them persistently. Reset restores the environment value." />
          </h3>
        </div>
        <SettingsEditor />
      </div>
    </div>
  )
}
