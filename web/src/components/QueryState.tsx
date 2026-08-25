/**
 * The three things a screen has to be able to say about the data it is showing: it is
 * loading, it failed (and here is the way to try again), or it is ready.
 *
 * Before this, each screen answered that question differently. Library and Graph did it
 * properly. Home had no error branch at all, so a failed `/jobs` rendered "Nothing yet -
 * drop a file on the left", i.e. an API error looked like an empty vault. System had no
 * error branch either and gated on `data === undefined`, so a failure sat on "Loading
 * usage…" forever. Both are worse than an error message: they are a wrong answer.
 *
 * `ready` returns null, so the caller keeps rendering its own content and this component
 * never has to know what that content is.
 */

/**
 * The part of a TanStack query this needs. Structural on purpose: `merge()` below returns
 * the same shape, so a screen fed by several queries passes one value like any other.
 */
export interface QueryLike {
  isLoading: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

/**
 * Several queries as one state: it fails if any of them failed (the first failure carries
 * the message and the retry), and it loads while any of them is still loading. Retrying
 * refetches all of them, because a screen that needs three queries is not usable until all
 * three are there.
 */
export function merge(...queries: QueryLike[]): QueryLike {
  const failed = queries.find((q) => q.isError)
  return {
    isLoading: queries.some((q) => q.isLoading),
    isError: failed !== undefined,
    error: failed?.error,
    refetch: () => queries.forEach((q) => void q.refetch()),
  }
}

/**
 * Deliberately a FUNCTION you call, not a component you render.
 *
 * As a component this is a trap: `<QueryState … />` is a React element, so it is truthy even
 * when the component would render nothing, and every `state ?? content` and
 * `if (state !== null)` at the call sites silently swallowed the content. TypeScript cannot
 * see it either - `ReactElement | null` is the return type of the function, while the JSX
 * expression has type `ReactElement`. Calling it means the null is real.
 *
 * `what` completes both sentences, so name the thing in lower case and with its article:
 * "the page index" gives "Loading the page index…" and "Could not load the page index."
 */
export function queryState(q: QueryLike, what: string): React.ReactElement | null {
  if (q.isError) {
    return (
      <div className="empty">
        <p className="qs-line">Could not load {what}.</p>
        <p className="qs-detail">{message(q.error)}</p>
        <button className="btn" onClick={() => void q.refetch()}>
          Try again
        </button>
      </div>
    )
  }
  if (q.isLoading) return <div className="empty">Loading {what}…</div>
  return null
}
