/**
 * Telegram bot configuration (SPEC.md §4.3): token + user-id allowlist, POSTed once to
 * /settings/telegram (which writes the service env file) and never displayed again — the
 * same lifecycle as the credential. Both fields travel together because the server side is
 * fail-closed (a token without an allowlist refuses startup).
 *
 * Activation is a restart: under systemd the server restarts itself (`restart: 'auto'`)
 * and this component polls /settings until the new process reports the changed bot status,
 * then reloads the page; otherwise it shows the manual restart step and polls the same way.
 */

import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../api/client.ts'
import type { TelegramSettingsResponse } from '../api/types.ts'

export function TelegramSetup({ status }: { status: string }): React.ReactElement {
  const configured = status !== 'off'
  const [open, setOpen] = useState(false)
  const [botToken, setBotToken] = useState('')
  const [allowedUserIds, setAllowedUserIds] = useState('')
  // Which bot status the restarted process should report: 'on' after save, 'off' after disable.
  const [result, setResult] = useState<{ res: TelegramSettingsResponse; expect: 'on' | 'off' } | null>(null)

  const save = useMutation({
    mutationFn: () => api.setTelegram({ botToken: botToken.trim(), allowedUserIds: allowedUserIds.trim() }),
    onSuccess: (res) => {
      setResult({ res, expect: 'on' })
      setBotToken('') // the token has no business lingering in component state
    },
  })
  const disable = useMutation({
    mutationFn: () => api.disableTelegram(),
    onSuccess: (res) => setResult({ res, expect: 'off' }),
  })

  // Poll until the restarted process reflects the change, then reload the page.
  useEffect(() => {
    if (!result) return
    const timer = setInterval(() => {
      api
        .settings()
        .then((s) => {
          const telegram = s.readOnly['telegram'] ?? 'off'
          if ((result.expect === 'on') === (telegram !== 'off')) window.location.reload()
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
        {result.res.restart === 'auto' ? (
          <>Telegram settings saved. The service is restarting — this page reloads automatically…</>
        ) : (
          <>
            Telegram settings saved to the service env file. Restart the service to activate them (
            <code>systemctl --user restart vault-service</code>) — this page reloads automatically
            once it is back.
          </>
        )}
      </div>
    )
  }

  if (!open) {
    return (
      <div className="setting-control">
        <button className="btn ghost" onClick={() => setOpen(true)}>
          {configured ? 'Replace Telegram settings…' : 'Set up Telegram bot…'}
        </button>
        {configured && (
          <button
            className="btn ghost"
            disabled={disable.isPending}
            onClick={() => {
              if (window.confirm('Disable the Telegram bot? The token is removed from the env file.')) {
                disable.mutate()
              }
            }}
          >
            {disable.isPending ? 'Disabling…' : 'Disable'}
          </button>
        )}
        {disable.isError && <div className="toast err">{(disable.error as Error).message}</div>}
      </div>
    )
  }

  return (
    <div className="credential-setup">
      <p className="setting-hint">
        Queue ingests and check status from your phone. Create a bot via @BotFather (it answers
        with the token) and get your numeric user id from @userinfobot — the bot answers ONLY the
        ids listed here. Both values are stored in the service env file on this machine (never in
        the database or the browser) and are not shown again.
      </p>

      <div className="setting-control">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="123456789:AAF… (bot token)"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
        />
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="111111111, 222222222 (user ids)"
          value={allowedUserIds}
          onChange={(e) => setAllowedUserIds(e.target.value)}
        />
        <button
          className="btn primary"
          disabled={botToken.trim().length < 20 || allowedUserIds.trim().length === 0 || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" disabled={save.isPending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      {save.isError && <div className="toast err">{(save.error as Error).message}</div>}
    </div>
  )
}
