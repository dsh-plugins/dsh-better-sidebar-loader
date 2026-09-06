/**
 * The host-side fetch pipeline behind /sidebar/proxy: take one already-approved
 * target, walk its redirects under the proxy policy, decode the document with
 * its own charset, and hand back the rewritten + bridge-injected page (or the
 * error document that explains why it could not be served).
 *
 * Split out of the route so the SSRF fence and the failure paths are testable
 * without an HTTP server: `fetch` is injected.
 * See src/browser-proxy.ts for the policy and the security posture.
 */
import { charsetOf, proxyErrorDocument, proxyPolicy, rewriteProxiedHtml } from './browser-proxy.ts'
import { injectPickerBridge } from './element-picker-bridge.ts'

/**
 * The User-Agent used when the caller has none to forward. A REAL browser UA
 * matters: many sites (baidu among them) answer an unknown agent with a
 * 200-byte "upgrade your browser" stub whose only content is a meta refresh —
 * proxied into an opaque-origin frame that stub renders as a blank page. ZCode
 * never hits this because its browser pane IS a browser; the closest we get is
 * asking upstream with the same identity the GUI's own browser would send.
 */
export const PROXY_FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** The pipeline's dependencies (all injectable for tests). */
export interface ProxyFetchOptions {
  /** The fetch implementation (the host passes the global one). */
  fetch: typeof globalThis.fetch
  /** Max decoded document size in bytes. */
  limit: number
  /** Abort the whole walk after this long (default 15s). */
  timeoutMs?: number
  /** Max redirect hops to follow (default 5). */
  maxHops?: number
  /** The framing browser's User-Agent (the route forwards the request's own). */
  userAgent?: string
  /** The framing browser's Accept-Language (content negotiation only). */
  acceptLanguage?: string
  /** Static mode: serve the page with its own scripts stripped. */
  noScript?: boolean
}

/**
 * Flatten one fetch failure into a readable sentence. Node's fetch throws a
 * bare `TypeError: fetch failed` and hides the real reason (DNS, TLS, refused
 * connection, missing proxy) in the `cause` chain — surfacing it is the
 * difference between an actionable message and a dead end.
 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    const label = typeof code === 'string' && code !== '' ? `${code}: ${current.message}` : current.message
    if (label !== '' && !parts.includes(label)) parts.push(label)
    current = (current as { cause?: unknown }).cause
  }
  if (typeof current === 'string' && current !== '') parts.push(current)
  return parts.length === 0 ? String(error) : parts.join(' — ')
}

/** What the route should send: an html body plus its status. */
export interface ProxyPage {
  status: number
  body: string
}

/**
 * Fetch and prepare one page for element picking.
 * @param target - the policy-approved initial target.
 * @param options - injected fetch + limits.
 * @returns the html document to serve (never throws).
 */
export async function fetchProxiedPage(target: URL, options: ProxyFetchOptions): Promise<ProxyPage> {
  const maxHops = options.maxHops ?? 5
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs ?? 15000)
  try {
    // Redirects are followed MANUALLY so the policy re-runs on every hop: an
    // upstream 302 to http://127.0.0.1/... must not turn this route into an
    // SSRF vector into the DSH host's own network.
    let current = target
    let response: Response | null = null
    for (let hop = 0; hop <= maxHops; hop++) {
      const attempt = await options.fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        // No cookie / authorization / referer: the fetch carries no identity,
        // neither the user's nor the GUI's.
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': options.acceptLanguage ?? 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent': options.userAgent ?? PROXY_FALLBACK_USER_AGENT,
        },
      })
      const location = attempt.status >= 300 && attempt.status <= 399 ? attempt.headers.get('location') : null
      if (location === null) {
        response = attempt
        break
      }
      let next: string
      try {
        next = new URL(location, current).href
      } catch {
        return { status: 502, body: proxyErrorDocument('该页面重定向到了无法解析的地址，无法代理加载') }
      }
      const verdict = proxyPolicy(next)
      if (!verdict.ok) {
        return { status: verdict.status, body: proxyErrorDocument(verdict.message) }
      }
      current = verdict.target
    }
    if (response === null) {
      return { status: 502, body: proxyErrorDocument('该页面的重定向层级过多，无法代理加载') }
    }
    const contentType = response.headers.get('content-type')
    if (!/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType ?? '')) {
      return {
        status: 415,
        body: proxyErrorDocument('仅支持代理 HTML 页面（当前响应类型：' + (contentType ?? '未知') + '）'),
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > options.limit) {
      return { status: 413, body: proxyErrorDocument('该页面超出了代理体积上限，无法加入元素选择') }
    }
    // Decode with the page's OWN charset — Response.text() would assume UTF-8
    // and mojibake every GBK/Big5 page — then the route re-serves as UTF-8
    // (the rewrite drops the now-wrong charset declarations).
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
    let source: string
    try {
      source = new TextDecoder(charsetOf(contentType, head)).decode(bytes)
    } catch {
      source = new TextDecoder('utf-8').decode(bytes)
    }
    return {
      status: 200,
      body: injectPickerBridge(rewriteProxiedHtml(source, current.href, options.noScript === true)),
    }
  } catch (error) {
    // DNS / TLS / connection / timeout / missing system proxy: the frame
    // explains the ACTUAL cause (see describeFetchError) instead of showing a
    // blank rectangle or a bare "fetch failed".
    return { status: 502, body: proxyErrorDocument('无法抓取该页面：' + describeFetchError(error)) }
  } finally {
    clearTimeout(timer)
  }
}
