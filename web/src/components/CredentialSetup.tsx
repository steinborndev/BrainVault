/**
 * Credential onboarding (SPEC.md §7.1): the form behind the "no credential configured"
 * setup mode, and the "Replace credential" flow once one exists. The value is POSTed once
 * to /settings/credential (which writes the service env file) and never displayed again.
 *
 * After a successful write the credential is start-time-bound server state, so activation
 * is a restart: under systemd the server restarts itself (`restart: 'auto'`) and this
 * component polls /health until the new process reports credentialConfigured, then reloads
 * the page; otherwise it shows the manual restart step and polls the same way.
 */

import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { CredentialResponse } from '../api/types.ts'

type Kind = 'oauth' | 'api-key'

const KIND_INFO: Record<Kind, { title: string; hint: string; placeholder: string }> = {
  oauth: {
    title: 'Claude subscription (recommended)',
    hint:
      'Uses your existing claude.ai subscription — no separate billing. Install the Claude Code ' +
      'CLI, run `claude setup-token` in a terminal, and paste the sk-ant-oat… token here.',
    placeholder: 'sk-ant-oat01-…',
  },
  'api-key': {
    title: 'Anthropic API key',
    hint:
      'Pay-per-use via console.anthropic.com (needs an API account with credits). ' +
      'Create a key under Settings → API keys and paste it here.',
    placeholder: 'sk-ant-api03-…',
  },
}

export function CredentialSetup({ configured }: { configured: boolean }): React.ReactElement {
  // In setup mode the form is the point — open it; when configured it hides behind a button.
  const [open, setOpen] = useState(!configured)
  const [kind, setKind] = useState<Kind>('oauth')
  const [value, setValue] = useState('')
  const [result, setResult] = useState<CredentialResponse | null>(null)

  const submit = useMutation({
    mutationFn: () => api.setCredential({ kind, value: value.trim() }),
    onSuccess: (res) => {
      setResult(res)
      setValue('') // the token has no business lingering in component state
    },
  })

  // Once written, poll until the restarted process reports the credential, then reload —
  // every tab (queue, watcher, chat) needs the fresh server state anyway.
  useEffect(() => {
    if (!result) return
    const timer = setInterval(() => {
      api
        .health()
        .then((h) => {
          if (h.credentialConfigured) window.location.reload()
        })
        .catch(() => {
          /* server mid-restart — keep polling */
        })
    }, 2000)
    return () => clearInterval(timer)
  }, [result])

  if (result) {
    return (
      <div className="toast warn">
        {result.restart === 'auto' ? (
          <>Credential saved. The service is restarting — this page reloads automatically…</>
        ) : (
          <>
            Credential saved to the service env file. Restart the service to activate it (
            <code>systemctl --user restart vault-service</code>, or re-run <code>npm start</code>) —
            this page reloads automatically once it is back.
          </>
        )}
      </div>
    )
  }

  if (!open) {
    return (
      <button className="btn ghost" onClick={() => setOpen(true)}>
        Replace credential…
      </button>
    )
  }

  return (
    <div className="credential-setup">
      {!configured && (
        <p className="setting-hint">
          Connect your Anthropic account to start ingesting. The key is stored in the service
          env file on this machine (never in the database or the browser) and is not shown again.
        </p>
      )}

      <div className="credential-kinds">
        {(Object.keys(KIND_INFO) as Kind[]).map((k) => (
          <label key={k} className={`credential-kind${kind === k ? ' selected' : ''}`}>
            <input type="radio" name="credential-kind" checked={kind === k} onChange={() => setKind(k)} />
            <span className="credential-kind-title">{KIND_INFO[k].title}</span>
            <span className="setting-hint">{KIND_INFO[k].hint}</span>
          </label>
        ))}
      </div>

      <div className="setting-control">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={KIND_INFO[kind].placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="btn primary"
          disabled={value.trim().length < 20 || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? 'Saving…' : 'Save credential'}
        </button>
        {configured && (
          <button className="btn ghost" disabled={submit.isPending} onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>

      {submit.isError && <div className="toast err">{(submit.error as Error).message}</div>}
    </div>
  )
}
