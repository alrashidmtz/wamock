/**
 * Point a client at wamock without changing the client.
 *
 * This exists because of what a dogfood pass against two production
 * integrations turned up: **both build their Graph URLs as string literals.**
 * Neither had a base-URL setting to override. That is the normal case, not an
 * oversight — nobody adds configuration for a hostname that never changes — and
 * it makes "just point it at the mock" impossible by configuration alone.
 *
 * So wamock swaps the destination underneath instead:
 *
 * ```ts
 * const mock = await createWamock({ appSecret: 's' })
 * const restore = installGraphInterceptor({ baseUrl: mock.baseUrl })
 * // ...the code under test calls https://graph.facebook.com/... unchanged
 * restore()
 * ```
 *
 * ## Scope, stated plainly
 *
 * This patches the global `fetch`. It covers code that uses `fetch` — which is
 * what current Node integrations do, including both audited ones — and does
 * **not** cover `axios`, `node-fetch`, or raw `http.request`. Those need their
 * own base URL or an HTTP proxy. Saying so here is better than letting someone
 * discover it from a test that mysteriously talks to the real Meta.
 *
 * ## The sharp edge: construction order
 *
 * Patching a global only reaches code that reads it **on every call**. A client
 * that captures it once — `constructor(private transport = globalThis.fetch)`,
 * a very common dependency-injection default — keeps the original if it was
 * built before this ran. Interception then does nothing, and says nothing:
 * requests go to the real `graph.facebook.com`, and with a valid token in the
 * environment that means real messages to real numbers.
 *
 * There is no fix from in here; wamock cannot see a `fetch` reference someone
 * else already holds. Build the client after the mock, and assert the traffic
 * arrived (`expect(mock.messages()).toHaveLength(n)`) — an empty inbox is the
 * only signal that it escaped.
 */

/** Hosts that belong to Meta's Graph API and should be redirected. */
const GRAPH_HOSTS = new Set(['graph.facebook.com', 'graph.instagram.com'])

/**
 * What `fetch` accepts. Declared here rather than pulled from the DOM lib:
 * wamock targets Node and adding `lib.dom` for one alias would drag in a
 * browser global namespace that does not apply.
 */
export type FetchInput = Request | string | URL

export type FetchImpl = (input: FetchInput, init?: RequestInit) => Promise<Response>

export interface InterceptorOptions {
  /** Where wamock is listening, e.g. `mock.baseUrl`. */
  baseUrl: string
  /** The fetch to delegate to. Defaults to the current global. Injected in tests. */
  fetchImpl?: FetchImpl
  /** Extra hostnames to redirect, if you proxy Graph through your own domain. */
  additionalHosts?: string[]
}

/**
 * Redirect Graph API calls to `baseUrl`. Returns a function that restores the
 * previous `fetch`; call it in your test teardown.
 */
export function installGraphInterceptor(options: InterceptorOptions): () => void {
  let target: URL
  try {
    target = new URL(options.baseUrl)
  } catch {
    // Failing loudly matters more than usual here: a typo'd base would leave
    // every Graph call going to the real Meta, which is the worst possible
    // outcome for a testing tool.
    throw new Error(`installGraphInterceptor: baseUrl '${options.baseUrl}' is not a valid URL`)
  }

  const hosts = new Set([...GRAPH_HOSTS, ...(options.additionalHosts ?? [])])
  const original = options.fetchImpl ?? globalThis.fetch
  const patched = globalThis.fetch

  const redirect = (url: URL): URL => {
    const rewritten = new URL(url.pathname + url.search, target)
    return rewritten
  }

  const interceptor: FetchImpl = async (input, init) => {
    // A Request carries method, headers and body with it, so rebuild it around
    // the new URL rather than dropping them on the floor.
    if (input instanceof Request) {
      const url = new URL(input.url)
      if (!hosts.has(url.hostname)) return original(input, init)
      return original(new Request(redirect(url), input), init)
    }

    const raw = typeof input === 'string' ? input : input.toString()
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      // Relative URL, or something we cannot parse — not ours to touch.
      return original(input, init)
    }

    if (!hosts.has(url.hostname)) return original(input, init)
    return original(redirect(url).toString(), init)
  }

  globalThis.fetch = interceptor as typeof globalThis.fetch

  let restored = false
  return () => {
    if (restored) return
    restored = true
    // Restore what was there when we installed, not a captured snapshot of the
    // original, so nested installs unwind in the right order.
    globalThis.fetch = patched
  }
}
