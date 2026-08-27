/**
 * Counts agent runs that are currently able to write the vault — ingest jobs AND maintenance
 * runs, which hold separate run mutexes and can therefore overlap each other.
 *
 * Why this exists (finding F4): the commit pathspec is derived from the run's `Write`/`Edit` tool
 * calls, so a page the agent creates or renames with **Bash** is invisible to it and stays
 * uncommitted. Recovering those by diffing "what became dirty during this run" is only sound when
 * nothing else was writing at the same time — the first attempt at that fix mis-attributed pages
 * across concurrent jobs (job A committed job B's page, B's commit then found nothing), which the
 * M1 acceptance test caught.
 *
 * This registry supplies the missing proof: a run may only sweep unattributed changes when it can
 * show it was the SOLE writer. With two jobs in flight the sweep is skipped — F4 persists for that
 * run, but nothing is ever attributed to the wrong job. Losing a page from a commit is visible and
 * fixable; silently filing it under the wrong job is not.
 *
 * THE BUSY PERIOD (2026-08-25). That trade-off left real pages outside git for a month: with
 * concurrency above 1, and a batch drop putting eight jobs in flight at once, "not the sole
 * writer" is the normal case rather than the exception, so the sweep almost never fired.
 *
 * The fix does not weaken the rule - it waits for a moment when the rule is trivially
 * satisfied. Attribution is impossible only while runs OVERLAP; once the count returns to
 * zero, nothing is writing and whatever is still dirty can only be leftovers. So the registry
 * also brackets the whole busy period: the first writer's `dirtyBefore` becomes the period
 * baseline, and the last writer to leave announces it. A reconcile pass can then commit the
 * remainder without ever guessing which job it belonged to - because at that instant the
 * question no longer has a wrong answer, only an unasked one.
 */

export class RunRegistry {
  private active = 0
  /** What was already dirty when the current busy period began; null while idle. */
  private periodBaseline: ReadonlySet<string> | null = null
  private idleListener: ((baseline: ReadonlySet<string>) => void) | null = null

  /**
   * Marks a run as writing the vault. Call before the agent starts and keep the returned handle
   * until AFTER the commit — the exclusivity question is asked at commit time, not at run end.
   * The returned function is idempotent, so a `finally` that runs twice cannot corrupt the count.
   *
   * `dirtyBefore` is the run's own F4 bracket. The FIRST writer of a busy period also donates
   * it as the period baseline, which costs nothing: it was captured immediately before this
   * run started, when by definition nothing else was writing. Later writers' baselines are
   * ignored - theirs already contain the earlier runs' work in progress.
   */
  begin(dirtyBefore?: ReadonlySet<string>): () => void {
    if (this.active === 0 && dirtyBefore !== undefined) this.periodBaseline = dirtyBefore
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      if (this.active > 0) return
      const baseline = this.periodBaseline
      this.periodBaseline = null
      // Fire-and-forget: this runs inside a `finally`, and a reconcile pass must never be
      // able to fail a run that has already done its work and committed.
      if (baseline !== null && this.idleListener !== null) {
        try {
          this.idleListener(baseline)
        } catch {
          /* swallowed - reconciliation is opportunistic bookkeeping, never a gate */
        }
      }
    }
  }

  /**
   * Called when the last writer of a busy period releases, with that period's baseline.
   * One listener: this is a single well-known consumer (the reconcile pass), not a bus.
   */
  onIdle(listener: (baseline: ReadonlySet<string>) => void): void {
    this.idleListener = listener
  }

  /** How many runs are currently able to write the vault. */
  get activeRuns(): number {
    return this.active
  }

  /**
   * True when the caller is the only active writer, i.e. anything unattributed that changed under
   * the wiki can only have come from this run. Call from inside the commit mutex.
   */
  isSoleWriter(): boolean {
    return this.active === 1
  }
}
