/**
 * A minimal FIFO async mutex. One use in M1: serializing vault git commits so two
 * workers finishing at concurrency 2 cannot run `git add`/`git commit` at the same
 * time and interleave each other's staged changes (SPEC.md §4 concurrency safety).
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  /** Runs `fn` once all previously-queued holders have released, then releases. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(fn).finally(release)
  }
}
