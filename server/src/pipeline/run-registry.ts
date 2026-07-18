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
 */

export class RunRegistry {
  private active = 0

  /**
   * Marks a run as writing the vault. Call before the agent starts and keep the returned handle
   * until AFTER the commit — the exclusivity question is asked at commit time, not at run end.
   * The returned function is idempotent, so a `finally` that runs twice cannot corrupt the count.
   */
  begin(): () => void {
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
    }
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
