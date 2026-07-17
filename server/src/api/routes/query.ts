/**
 * Query/Chat + sessions API (SPEC.md §5, §6.3, §6.5).
 *
 * `POST /api/v1/query` runs the READ-ONLY query runner against the vault and returns a
 * synthesized answer with resolved page citations (the clickable chips — the M4 DoD).
 * Sessions persist the conversation and the SDK session id so follow-ups keep context.
 *
 * This first cut is request/response (no token streaming); the answer is returned whole when
 * the run completes. Live streaming is layered on when the Chat UI lands (TASKS-M4 §1) — the
 * shape here (persist user msg → run → persist assistant msg) is unchanged by that.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import { runQuery as defaultRunQuery, type QueryRunner } from '../../pipeline/query-runner.js'
import { extractCitations, indexWikiPages } from '../../pipeline/citations.js'

export function registerQueryRoute(app: FastifyInstance, ctx: AppContext): void {
  const { config, chat } = ctx
  const runQuery: QueryRunner = ctx.runQuery ?? defaultRunQuery

  app.post('/api/v1/query', async (req, reply) => {
    const body = (req.body ?? {}) as { question?: unknown; sessionId?: unknown }
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (question === '') return reply.code(400).send({ error: 'provide a non-empty "question"' })

    // Resolve or create the session; a follow-up carries the SDK session id to resume.
    let session = typeof body.sessionId === 'string' ? chat.getSession(body.sessionId) : undefined
    if (typeof body.sessionId === 'string' && session === undefined) {
      return reply.code(404).send({ error: 'no such session' })
    }
    session ??= chat.createSession({ title: deriveTitle(question) })

    chat.addMessage({ sessionId: session.id, role: 'user', content: question })

    const res = await runQuery({
      vaultRoot: config.vaultRoot,
      question,
      auth: config.auth,
      ...(session.sdk_session_id ? { resumeSessionId: session.sdk_session_id } : {}),
    })

    if (!res.ok) {
      const message = chat.addMessage({
        sessionId: session.id,
        role: 'system',
        content: `Query failed: ${res.error ?? 'unknown error'}`,
      })
      return reply.code(502).send({ sessionId: session.id, error: res.error ?? 'query failed', message })
    }

    // Remember the SDK session for the next turn's resume.
    if (res.sessionId) chat.setSdkSessionId(session.id, res.sessionId)

    const citations = extractCitations(res.result, config.vaultRoot, indexWikiPages(config.vaultRoot))
    const message = chat.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: res.result,
      citations,
    })

    return reply.code(200).send({
      sessionId: session.id,
      message,
      citations,
      usage: res.usage,
      authMode: config.auth.mode, // so the UI can label cost "Schätzwert (Abo)" (SPEC.md §7.1)
    })
  })

  // ---- Sessions ----

  app.get('/api/v1/sessions', async (req) => {
    return { sessions: chat.listSessions(req.userId) }
  })

  app.post('/api/v1/sessions', async (req, reply) => {
    const body = (req.body ?? {}) as { title?: unknown }
    const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined
    const session = chat.createSession({ userId: req.userId, ...(title ? { title } : {}) })
    return reply.code(201).send({ session })
  })

  app.get('/api/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = chat.getSession(id)
    if (session === undefined) return reply.code(404).send({ error: 'no such session' })
    return { session, messages: chat.messages(id) }
  })

  app.patch('/api/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (chat.getSession(id) === undefined) return reply.code(404).send({ error: 'no such session' })
    const body = (req.body ?? {}) as { title?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (title === '') return reply.code(400).send({ error: 'provide a non-empty "title"' })
    return { session: chat.renameSession(id, title) }
  })

  app.delete('/api/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const removed = chat.deleteSession(id)
    if (!removed) return reply.code(404).send({ error: 'no such session' })
    return reply.code(200).send({ ok: true })
  })
}

/** A first-question-derived session title (trimmed to a sensible chip length). */
function deriveTitle(question: string): string {
  const oneLine = question.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57)}…`
}
