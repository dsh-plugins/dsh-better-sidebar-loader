/**
 * The element-picker PROXY vocabulary: the /sidebar/proxy route's URL form,
 * its fetch policy, and the HTML rewrite that makes a remote page pickable.
 *
 * Why a proxy exists at all: the browser tab frames a REMOTE origin, and a
 * cross-origin document can never be scripted from the GUI (see
 * element-picker.ts) — the picker bridge can only ride in bytes this plugin
 * serves itself. This route fetches ONE html document host-side and re-serves
 * it from the GUI's origin with the bridge injected, so the crosshair works on
 * an arbitrary site. It is opt-in per surface: the browser tab loads the direct
 * URL until the user asks to pick an element.
 *
 * What it deliberately does NOT do: it proxies the top document only. A
 * rewritten `<base href>` points every relative reference back at the real
 * origin, so stylesheets, scripts and images load straight from the site the
 * way they always did — this route never becomes a general web proxy, and no
 * request the page makes carries the GUI's identity. Pages that need
 * same-origin XHR, service workers or cookies WILL degrade; that is the
 * documented price of picking an element on a foreign page.
 *
 * Security posture (mirrors the /sidebar/html previewer):
 * - the served document keeps the CSP `sandbox` directive (no
 *   allow-same-origin), so despite living on the GUI's origin it is an opaque
 *   origin: no GUI storage, no credentialed /sidebar/api call;
 * - no cookie, authorization or referer header is forwarded upstream, and no
 *   `set-cookie` comes back;
 * - the target must be http(s) and must not name the local machine or a
 *   private/link-local address — checked again on EVERY redirect hop, because
 *   this fetch runs on the DSH host (a remote-access deployment must not gain
 *   a reach into the host's network). Hostnames that RESOLVE to a private
 *   address are not caught: that needs resolve-and-pin, out of scope here.
 *
 * Dependency-free (no node imports): the client imports the encoder, the host
 * imports the policy + rewrite, and the tests drive all three.
 */

/** The route path (the target rides in the `url` query parameter). */
export const PROXY_ROUTE_PREFIX = '/sidebar/proxy'

/** The token route: the fenced same-origin call that mints a proxy capability. */
export const TOKEN_ROUTE_PATH = '/sidebar/proxy-token'

/**
 * Build the route URL for one absolute http(s) target.
 * @param target - the page to re-serve.
 * @param token - the capability token from `browser.proxyToken`. Required in
 *                practice: the proxied page loads into a SANDBOXED frame, whose
 *                opaque origin makes the browser send `Origin: null`, which
 *                the route's cross-site fence refuses on its own (see
 *                src/browser-proxy-token.ts).
 * @param noScript - serve the page with its own scripts stripped (static mode).
 *                   The escape hatch for pages that paint nothing under the
 *                   proxy: frame-busters, canonical-URL self-redirects and
 *                   scripts that die in an opaque origin all stop mattering,
 *                   and a server-rendered document stays perfectly pickable.
 */
export function encodeProxyUrl(target: string, token?: string, noScript = false): string {
  const parts = ['url=' + encodeURIComponent(target)]
  if (token !== undefined && token !== '') parts.push('t=' + encodeURIComponent(token))
  if (noScript) parts.push('noscript=1')
  return PROXY_ROUTE_PREFIX + '?' + parts.join('&')
}

/** Policy verdict for one candidate target (initial URL or redirect hop). */
export type ProxyVerdict =
  | { ok: true; target: URL }
  | { ok: false; status: 400 | 403; message: string }

/** IPv4 literal parts, or undefined when the hostname is not dotted-quad. */
function ipv4Parts(hostname: string): number[] | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4) return undefined
  const numbers = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return numbers.some(part => Number.isNaN(part) || part > 255) ? undefined : numbers
}

/**
 * Whether a hostname names the local machine or a private / link-local
 * address LITERAL (loopback, 10/8, 172.16/12, 192.168/16, 169.254/16,
 * 100.64/10, IPv6 loopback / unique-local / link-local).
 */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '[::1]' || host === '::1') return true
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1)
    // fc00::/7 (unique local) and fe80::/10 (link local).
    if (/^f[cd]/.test(inner) || /^fe[89ab]/.test(inner)) return true
  }
  const parts = ipv4Parts(host)
  if (parts === undefined) return false
  const [a = 0, b = 0] = parts
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** Apply the fetch policy to one candidate target. */
export function proxyPolicy(raw: string): ProxyVerdict {
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return { ok: false, status: 400, message: 'invalid url' }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, status: 400, message: 'only http/https pages can be proxied' }
  }
  if (isInternalHostname(target.hostname)) {
    return { ok: false, status: 403, message: 'local and private addresses are not proxied' }
  }
  return { ok: true, target }
}

/** Decode one /sidebar/proxy request URL into its policy verdict. */
export function decodeProxyRequest(requestUrl: string): ProxyVerdict {
  let parsed: URL
  try {
    parsed = new URL(requestUrl, 'http://dsh.internal')
  } catch {
    return { ok: false, status: 400, message: 'invalid request url' }
  }
  const raw = parsed.searchParams.get('url')
  if (raw === null || raw === '') return { ok: false, status: 400, message: 'url is required' }
  return proxyPolicy(raw)
}

/** The capability token carried by one /sidebar/proxy request (null = none). */
export function proxyRequestToken(requestUrl: string): string | null {
  try {
    return new URL(requestUrl, 'http://dsh.internal').searchParams.get('t')
  } catch {
    return null
  }
}

/** Whether one /sidebar/proxy request asked for static (script-free) mode. */
export function proxyRequestNoScript(requestUrl: string): boolean {
  try {
    return new URL(requestUrl, 'http://dsh.internal').searchParams.get('noscript') === '1'
  } catch {
    return false
  }
}

/** Whether the client may offer proxied picking for this address-bar value. */
export function isProxyablePage(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false
  return proxyPolicy(raw).ok
}

/**
 * The character encoding one fetched document must be decoded with: the
 * response's own `content-type` charset wins, then the document's
 * `<meta charset>` / `<meta http-equiv="content-type">` (a GBK/Big5 page
 * usually declares it only there), and UTF-8 is the fallback. WHATWG
 * `Response.text()` always assumes UTF-8, which would mojibake every
 * legacy-encoded page — hence this explicit sniff.
 * @param contentType - the upstream `content-type` header, or null.
 * @param headSnippet - the first bytes of the document decoded as latin1
 *                      (enough for the meta tags, which are ASCII).
 */
export function charsetOf(contentType: string | null, headSnippet: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1]
  if (fromHeader !== undefined) return fromHeader.toLowerCase()
  const fromMeta = /<meta\s+charset\s*=\s*["']?([\w-]+)/i.exec(headSnippet)?.[1]
  if (fromMeta !== undefined) return fromMeta.toLowerCase()
  const fromEquiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(headSnippet)?.[1]
  if (fromEquiv !== undefined) return fromEquiv.toLowerCase()
  return 'utf-8'
}

/** Escape one attribute value for the rewritten markup. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape text for the error document. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Rewrite one fetched document so it behaves inside the GUI's origin:
 * - every `<meta http-equiv="content-security-policy">` is dropped (the
 *   page's own policy would block the injected bridge; the response header
 *   this route sends is the boundary that matters),
 * - the charset declarations are dropped too: this route re-encodes the body
 *   as UTF-8 and says so in its own header (which outranks a meta anyway), so
 *   a leftover `<meta charset="gbk">` would only mojibake the page,
 * - an existing `<base href>` is resolved against the real page URL, and
 *   a document without one gets `<base href="<page url>">` — so relative
 *   AND root-relative references keep resolving against the origin they came
 *   from instead of this route.
 *
 * The bridge injection is deliberately NOT done here (the caller composes it)
 * so the client bundle can import this module without the payload.
 * @param html - the fetched document source.
 * @param pageUrl - the FINAL url the document was fetched from (post-redirect).
 * @param noScript - static mode: drop the page's OWN scripts (the injected
 *                   bridge is added afterwards, so it survives). Frame-busters,
 *                   canonical-URL self-redirects and scripts that throw in an
 *                   opaque origin are the usual reason a proxied page paints
 *                   nothing; without them a server-rendered document renders.
 */
export function rewriteProxiedHtml(html: string, pageUrl: string, noScript = false): string {
  const source = noScript
    ? html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script\b[^>]*\/?>/gi, '')
    : html
  const stripped = source
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/gi, '')
    .replace(/<meta\s+charset\s*=\s*[^>]*>/gi, '')
  const existing = /<base\b[^>]*>/i.exec(stripped)
  if (existing !== null) {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(existing[0])
    const raw = href?.[2] ?? href?.[3] ?? href?.[4]
    let resolved = pageUrl
    if (raw !== undefined && raw !== '') {
      try {
        resolved = new URL(raw, pageUrl).href
      } catch {
        resolved = pageUrl
      }
    }
    const replacement = '<base href="' + escapeAttribute(resolved) + '">'
    return stripped.slice(0, existing.index) + replacement + stripped.slice(existing.index + existing[0].length)
  }
  const tag = '<base href="' + escapeAttribute(pageUrl) + '">'
  const head = /<head[^>]*>/i.exec(stripped)
  if (head !== null) {
    const at = head.index + head[0].length
    return stripped.slice(0, at) + tag + stripped.slice(at)
  }
  const root = /<html[^>]*>/i.exec(stripped)
  if (root !== null) {
    const at = root.index + root[0].length
    return stripped.slice(0, at) + '<head>' + tag + '</head>' + stripped.slice(at)
  }
  return '<head>' + tag + '</head>' + stripped
}

/**
 * The document served instead of a page that could not be proxied (a policy
 * refusal, an upstream failure, a non-HTML response). It carries no bridge, so
 * the sidebar's crosshair simply stays unavailable — and the frame shows the
 * reason instead of a blank rectangle.
 * @param reason - one human-readable sentence (shown verbatim).
 */
export function proxyErrorDocument(reason: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>proxy failed</title></head>',
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;',
    'font:13px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#6b7280;text-align:center">',
    '<p style="max-width:32em;padding:24px">' + escapeText(reason) + '</p>',
    '</body></html>',
  ].join('')
}
