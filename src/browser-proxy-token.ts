/**
 * The element-picker proxy's per-process capability token.
 *
 * Why a token exists: the proxied page loads INTO the browser tab's sandboxed
 * iframe. That frame has an OPAQUE origin (no allow-same-origin), so the
 * browser labels its navigation `Origin: null` /
 * `Sec-Fetch-Site: cross-site` — exactly the markers the sidebar's
 * cross-site fence must keep refusing, or a foreign page could drive these
 * routes. The token restores the boundary the fence can no longer see: it is
 * minted in this process, handed out ONLY over the fenced /sidebar/api
 * (`browser.proxyToken`), and required on any /sidebar/proxy request the
 * fence rejects. A cross-site page cannot read it, because it cannot make that
 * same-origin API call.
 *
 * Documented tradeoff: the proxied document can read the token out of its own
 * URL. What that buys the page is bounded — one route that fetches a PUBLIC
 * http(s) page with no cookie, no authorization and no GUI identity, and hands
 * it back inside the same opaque-origin sandbox. It grants no file, session or
 * settings access.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Hex length of the minted token (32 bytes). */
const TOKEN_CHARS = 64

let minted: string | undefined

/** The token for this plugin load (minted on first use). */
export function pickerProxyToken(): string {
  minted ??= randomBytes(TOKEN_CHARS / 2).toString('hex')
  return minted
}

/**
 * Whether a request's `t` parameter is this process's token.
 * @param candidate - the raw query value (null when absent).
 */
export function isPickerProxyToken(candidate: string | null | undefined): boolean {
  if (typeof candidate !== 'string' || candidate.length !== TOKEN_CHARS) return false
  // Length is checked first so timingSafeEqual never sees mismatched buffers.
  return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(pickerProxyToken(), 'utf8'))
}
