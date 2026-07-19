/**
 * Settings editor (SPEC.md §6.4 "Einstellungen"): watch folder, concurrency, file limit,
 * git commit behaviour — plus the read-only API-key STATUS. The key itself is never shown:
 * the server only ever sends its source/mode (hard rule 3).
 *
 * Precedence mirrors the server's single model: env/env-file is the start-time baseline, these
 * are runtime overrides, effective = override ?? baseline. Fields bound at startup (watch folder,
 * upload limit) are flagged "Restart required" rather than pretending they took effect live.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { EffectiveSettings, SettingsPatch, SettingsResponse } from '../api/types.ts'

const MB = 1024 * 1024

/** Labels for the read-only status block. Anything unmapped is hidden. */
const READ_ONLY_LABELS: Record<string, string> = {
  vaultRoot: 'Vault',
  bind: 'Address',
  httpAuthMode: 'HTTP auth',
  authMode: 'Anthropic mode',
  credentialSource: 'Credential source',
}

export function SettingsEditor(): React.ReactElement {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [draft, setDraft] = useState<EffectiveSettings | null>(null)
  const [pendingRestart, setPendingRestart] = useState<string[]>([])

  // Seed the draft once the settings arrive; later server responses re-seed it explicitly.
  useEffect(() => {
    if (q.data) setDraft((current) => current ?? q.data.effective)
  }, [q.data])

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api.saveSettings(patch),
    onSuccess: (res: SettingsResponse) => {
      qc.setQueryData(['settings'], res)
      setDraft(res.effective)
      setPendingRestart(res.pendingRestart ?? [])
      // A changed watch folder / concurrency shows up in the Overview's queue + watcher stats.
      qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  if (q.isError) return <div className="toast err">{(q.error as Error).message}</div>
  if (!q.data || !draft) return <div className="tab-hint">Loading settings…</div>

  const data = q.data
  // The budget's unit follows the Anthropic auth mode: ingests/day on a subscription (where
  // there is no per-run charge), USD/day with an API key (SPEC.md §7.1).
  const budgetUnit = data.readOnly.authMode === 'oauth' ? 'jobs' : 'usd'
  const keys = Object.keys(draft) as Array<keyof EffectiveSettings>
  const dirty = keys.filter((k) => draft[k] !== data.effective[k])
  const isOverridden = (k: keyof EffectiveSettings): boolean => data.overrides[k] !== undefined
  const needsRestart = (k: keyof EffectiveSettings): boolean => data.restartRequiredKeys.includes(k)

  const submit = (): void => {
    const patch: SettingsPatch = {}
    for (const k of dirty) Object.assign(patch, { [k]: draft[k] })
    save.mutate(patch)
  }

  const row = (
    k: keyof EffectiveSettings,
    label: string,
    hint: string,
    control: React.ReactNode,
  ): React.ReactElement => (
    <div className="setting" key={k}>
      <div>
        <div className="setting-label">
          {label}
          {needsRestart(k) && <span className="setting-tag warn">Restart required</span>}
          {isOverridden(k) && <span className="setting-tag">overridden</span>}
        </div>
        <div className="setting-hint">{hint}</div>
      </div>
      <div className="setting-control">
        {control}
        {isOverridden(k) && (
          <button
            className="btn ghost"
            title="Reset to the value from the environment"
            disabled={save.isPending}
            onClick={() => save.mutate({ [k]: null } as SettingsPatch)}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  )

  // The baseline/override explanation lives in the card title's ⓘ tooltip (Maintenance tab).
  return (
    <div>
      <div className="settings-grid">
        {row(
          'watchFolder',
          'Watch folder',
          'Folder watched for new files.',
          <input
            type="text"
            value={draft.watchFolder}
            onChange={(e) => setDraft({ ...draft, watchFolder: e.target.value })}
          />,
        )}

        {row(
          'concurrency',
          'Concurrency',
          'Simultaneous ingest runs (1–8). Takes effect immediately.',
          <input
            type="number"
            min={1}
            max={8}
            value={draft.concurrency}
            onChange={(e) => setDraft({ ...draft, concurrency: Number(e.target.value) })}
          />,
        )}

        {row(
          'maxUploadBytes',
          'File limit',
          'Maximum upload size per file (MB).',
          <input
            type="number"
            min={1}
            value={Math.round(draft.maxUploadBytes / MB)}
            onChange={(e) => setDraft({ ...draft, maxUploadBytes: Math.max(1, Number(e.target.value)) * MB })}
          />,
        )}

        {row(
          'gitAutoCommit',
          'Git auto-commit',
          'Commit automatically after every ingest. Off: pages land on disk without a commit.',
          <input
            type="checkbox"
            checked={draft.gitAutoCommit}
            onChange={(e) => setDraft({ ...draft, gitAutoCommit: e.target.checked })}
          />,
        )}

        {row(
          'dailyBudget',
          'Daily budget',
          budgetUnit === 'jobs'
            ? 'Ingests per day; beyond that the queue pauses until midnight. Empty = no limit.'
            : 'USD per day; beyond that the queue pauses until midnight. Empty = no limit.',
          <div className="setting-control">
            <input
              type="number"
              min={budgetUnit === 'usd' ? 0.01 : 1}
              step={budgetUnit === 'usd' ? 0.5 : 1}
              placeholder="no limit"
              value={draft.dailyBudget ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, dailyBudget: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
            <span className="setting-hint" style={{ marginTop: 0 }}>
              {budgetUnit === 'jobs' ? 'ingests/day' : 'USD/day'}
            </span>
          </div>,
        )}
      </div>

      <div className="setting-actions">
        <button className="btn primary" disabled={dirty.length === 0 || save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : dirty.length > 0 ? `Save (${dirty.length})` : 'Saved'}
        </button>
        {dirty.length > 0 && (
          <button className="btn ghost" disabled={save.isPending} onClick={() => setDraft(data.effective)}>
            Discard
          </button>
        )}
      </div>

      {save.isError && <div className="toast err">{(save.error as Error).message}</div>}
      {pendingRestart.length > 0 && (
        <div className="toast warn">
          Saved. {pendingRestart.join(', ')} require{pendingRestart.length === 1 ? 's' : ''} a restart:{' '}
          <code>systemctl --user restart vault-service</code>
        </div>
      )}

      <h4 className="settings-ro-title">Status (read-only)</h4>
      <div className="settings-ro">
        {Object.entries(READ_ONLY_LABELS).map(([key, label]) =>
          data.readOnly[key] ? (
            <div className="settings-ro-row" key={key}>
              <span className="settings-ro-label">{label}</span>
              <code>{data.readOnly[key]}</code>
            </div>
          ) : null,
        )}
      </div>
      <p className="setting-hint">
        The API key itself is never shown or stored — only its source. Address and credential are
        deliberately not changeable through the UI.
      </p>
    </div>
  )
}
