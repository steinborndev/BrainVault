/**
 * Commits wiki pages that no run staged, at the one moment when doing so cannot be wrong.
 *
 * THE PROBLEM. A run's commit pathspec is built from its `Write`/`Edit` tool calls, so a page
 * the agent creates with Bash is invisible to it (finding F4). The per-run sweep that catches
 * those (`newWikiPaths`) only fires when the run can prove it was the SOLE vault writer,
 * because attributing a page to the wrong job is a worse failure than missing it. That rule
 * is right. It is also almost never satisfied: concurrency is above 1 by default, and a batch
 * drop puts eight jobs in flight at once, so the sweep sits out nearly every real ingest.
 * Two dozen pages sat outside git for a month as a result, silently - they rendered, they
 * resolved links, they were indexed, and they had no history.
 *
 * THE FIX does not relax the attribution rule; it waits for the rule to become trivial.
 * Attribution is only impossible while runs overlap. When the writer count returns to zero,
 * nothing is writing, and anything still dirty under `wiki/` can only be a leftover - there
 * is no other job it could belong to. So the reconcile pass runs on that edge and commits
 * exactly the remainder.
 *
 * WHAT IT WILL AND WILL NOT TOUCH:
 *
 *  - Only paths that became dirty DURING the busy period. The first writer's F4 bracket is
 *    the period baseline, so anything the user already had in progress before the pipeline
 *    started is excluded (SPEC.md §11.3 risk 5).
 *  - Only `wiki/**`. `.raw/` payloads and `.vault-meta/` artifacts are dirty by design and
 *    belong to the runs that own them.
 *  - Never `git add -A`. An explicit pathspec, like every other commit this service makes.
 *
 * THE RESIDUAL EXPOSURE, stated plainly: a page the user edits in Obsidian *during* a busy
 * period is indistinguishable from one an agent wrote with Bash, and will be committed. That
 * is the same exposure the per-run sweep already accepts, over a longer window. It is worth
 * taking, because the two outcomes are not symmetric - a user edit committed early is
 * visible in one labelled commit and revertable in one command, whereas the status quo loses
 * knowledge pages from history without a trace.
 */

import { commitPaths, dirtyPaths, newWikiPaths } from './git.js'
import type { EventBus } from './events.js'
import type { RunRegistry } from './run-registry.js'
import type { Mutex } from '../util/mutex.js'

export interface ReconcilerOptions {
  readonly vaultRoot: string
  /** Shared with the queue and the maintenance runner, so this can never interleave. */
  readonly commitMutex: Mutex
  readonly runRegistry: RunRegistry
  readonly events: EventBus
  /** Live `gitAutoCommit` setting, read per pass exactly like the queue reads it. */
  readonly autoCommit?: () => boolean
  readonly commit?: typeof commitPaths
}

export interface ReconcileResult {
  /** Pages this pass committed; empty when there was nothing left over. */
  readonly pages: string[]
  readonly hash?: string
}

export class VaultReconciler {
  private readonly vaultRoot: string
  private readonly commitMutex: Mutex
  private readonly runRegistry: RunRegistry
  private readonly events: EventBus
  private readonly autoCommit: () => boolean
  private readonly commit: typeof commitPaths
  /** Serializes passes against each other; the mutex covers everything else. */
  private inPass = false

  constructor(opts: ReconcilerOptions) {
    this.vaultRoot = opts.vaultRoot
    this.commitMutex = opts.commitMutex
    this.runRegistry = opts.runRegistry
    this.events = opts.events
    this.autoCommit = opts.autoCommit ?? ((): boolean => true)
    this.commit = opts.commit ?? commitPaths
  }

  /** Subscribes to the busy-to-idle edge. Call once at startup. */
  attach(): void {
    this.runRegistry.onIdle((baseline) => {
      void this.reconcile(baseline).catch(() => {
        /* logged inside; a failed pass must never surface as a run failure */
      })
    })
  }

  /**
   * One pass. Safe to call directly (tests, a future manual trigger); the idle edge is just
   * the usual caller.
   */
  async reconcile(baseline: ReadonlySet<string>): Promise<ReconcileResult> {
    if (this.inPass) return { pages: [] }
    if (!this.autoCommit()) {
      this.log('info', 'reconcile: skipped, gitAutoCommit is off')
      return { pages: [] }
    }
    this.inPass = true
    try {
      return await this.commitMutex.runExclusive(async () => {
        // Re-checked INSIDE the mutex, not at the edge that scheduled us: a new run can start
        // in between, and then its pages are its own to commit. Same discipline as the
        // sole-writer check, asked at the moment it is acted on.
        if (this.runRegistry.activeRuns > 0) return { pages: [] }

        const leftovers = newWikiPaths(baseline, await dirtyPaths(this.vaultRoot))
        if (leftovers.length === 0) return { pages: [] }

        this.log(
          'info',
          `reconcile: ${leftovers.length} page(s) no run committed - the writers have all finished, so they can only be leftovers`,
        )
        const result = await this.commit(
          this.vaultRoot,
          `reconcile: ${leftovers.length} page(s) left uncommitted`,
          leftovers,
        )
        if (!result.committed) {
          this.log('info', `reconcile: nothing to commit (${result.note ?? 'no change'})`)
          return { pages: [] }
        }
        this.log('info', `reconcile: committed ${result.hash?.slice(0, 8)} (${result.committedPages.length} page(s))`)
        // The page count and the activity stream both changed.
        this.events.publish({ kind: 'stats' })
        return {
          pages: result.committedPages,
          ...(result.hash !== undefined ? { hash: result.hash } : {}),
        }
      })
    } catch (err) {
      this.log('warn', `reconcile: pass failed (ignored): ${(err as Error).message}`)
      return { pages: [] }
    } finally {
      this.inPass = false
    }
  }

  /**
   * Reconcile passes belong to no job, so they log on their own channel. The dashboard reads
   * the commit itself out of the activity stream; this is for the service log.
   */
  private log(level: 'info' | 'warn', message: string): void {
    this.events.publish({
      kind: 'log',
      log: { jobId: 'reconcile', ts: new Date().toISOString(), level, message },
    })
  }
}
