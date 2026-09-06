/**
 * Proxy fetch-pipeline specs: the redirect walk under the SSRF fence, the
 * charset decode, and every failure path — driven with an injected fetch, so
 * no network and no HTTP server is involved.
 */
import { describe, expect, it } from 'vitest'
import { PROXY_FALLBACK_USER_AGENT, describeFetchError, fetchProxiedPage } from '../src/browser-proxy-fetch.ts'

/** One scripted upstream answer. */
interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: Uint8Array | string
}

/** A fetch stand-in: answers per URL and records the walk. */
function fakeFetch(replies: Record<string, Reply>) {
  const seen: string[] = []
  const fetch = (async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input.href : String(input)
    seen.push(url)
    const reply = replies[url]
    if (reply === undefined) throw new Error('unexpected fetch: ' + url)
    const bytes = typeof reply.body === 'string' ? new TextEncoder().encode(reply.body) : reply.body ?? new Uint8Array()
    // A copy's buffer is a plain ArrayBuffer, which BodyInit accepts.
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      status: reply.status ?? 200,
      headers: reply.headers ?? { 'content-type': 'text/html; charset=utf-8' },
    })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const LIMIT = 1_000_000

describe('proxy fetch pipeline', () => {
  it('serves the rewritten page with the bridge injected', async () => {
    const { fetch } = fakeFetch({
      'https://example.com/a/': { body: '<html><head><title>t</title></head><body><h1>hi</h1></body></html>' },
    })
    const page = await fetchProxiedPage(new URL('https://example.com/a/'), { fetch, limit: LIMIT })
    expect(page.status).toBe(200)
    expect(page.body).toContain('data-dsh-element-picker-bridge')
    expect(page.body).toContain('<base href="https://example.com/a/">')
    expect(page.body).toContain('<h1>hi</h1>')
  })

  it('follows a public redirect and bases the page on the FINAL url', async () => {
    const { fetch, seen } = fakeFetch({
      'https://example.com/old': { status: 301, headers: { location: '/new/page.html' } },
      'https://example.com/new/page.html': { body: '<html><head></head><body>x</body></html>' },
    })
    const page = await fetchProxiedPage(new URL('https://example.com/old'), { fetch, limit: LIMIT })
    expect(page.status).toBe(200)
    expect(page.body).toContain('<base href="https://example.com/new/page.html">')
    expect(seen).toEqual(['https://example.com/old', 'https://example.com/new/page.html'])
  })

  it('refuses a redirect into the local machine WITHOUT fetching it', async () => {
    const { fetch, seen } = fakeFetch({
      'https://example.com/jump': { status: 302, headers: { location: 'http://127.0.0.1:9000/admin' } },
    })
    const page = await fetchProxiedPage(new URL('https://example.com/jump'), { fetch, limit: LIMIT })
    expect(page.status).toBe(403)
    expect(page.body).toContain('local and private addresses are not proxied')
    expect(page.body).not.toContain('data-dsh-element-picker-bridge')
    expect(seen).toEqual(['https://example.com/jump'])
  })

  it('refuses a redirect into a private range and a cloud metadata address', async () => {
    for (const location of ['http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/']) {
      const { fetch, seen } = fakeFetch({
        'https://example.com/jump': { status: 307, headers: { location } },
      })
      const page = await fetchProxiedPage(new URL('https://example.com/jump'), { fetch, limit: LIMIT })
      expect(page.status, location).toBe(403)
      expect(seen).toHaveLength(1)
    }
  })

  it('gives up on a redirect loop', async () => {
    const { fetch, seen } = fakeFetch({
      'https://example.com/loop': { status: 302, headers: { location: 'https://example.com/loop' } },
    })
    const page = await fetchProxiedPage(new URL('https://example.com/loop'), { fetch, limit: LIMIT, maxHops: 3 })
    expect(page.status).toBe(502)
    expect(page.body).toContain('重定向层级过多')
    expect(seen).toHaveLength(4)
  })

  it('refuses a non-HTML response', async () => {
    const { fetch } = fakeFetch({
      'https://example.com/a.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' },
    })
    const page = await fetchProxiedPage(new URL('https://example.com/a.pdf'), { fetch, limit: LIMIT })
    expect(page.status).toBe(415)
    expect(page.body).toContain('application/pdf')
  })

  it('refuses an oversize document', async () => {
    const { fetch } = fakeFetch({
      'https://example.com/big': { body: '<html><head></head><body>' + 'x'.repeat(5000) + '</body></html>' },
    })
    const page = await fetchProxiedPage(new URL('https://example.com/big'), { fetch, limit: 1000 })
    expect(page.status).toBe(413)
  })

  it('decodes a legacy-encoded page with its own charset', async () => {
    // "中文" in GBK (d6d0 cec4) — Response.text() would mojibake this.
    const gbk = new Uint8Array([
      ...new TextEncoder().encode('<html><head></head><body><p>'),
      0xd6, 0xd0, 0xce, 0xc4,
      ...new TextEncoder().encode('</p></body></html>'),
    ])
    const { fetch } = fakeFetch({
      'https://example.com/gbk': { headers: { 'content-type': 'text/html; charset=gbk' }, body: gbk },
    })
    const page = await fetchProxiedPage(new URL('https://example.com/gbk'), { fetch, limit: LIMIT })
    expect(page.status).toBe(200)
    expect(page.body).toContain('<p>中文</p>')
  })

  it('explains an upstream failure instead of throwing', async () => {
    const fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND nope.invalid') }) as typeof globalThis.fetch
    const page = await fetchProxiedPage(new URL('https://nope.invalid/'), { fetch, limit: LIMIT })
    expect(page.status).toBe(502)
    expect(page.body).toContain('ENOTFOUND')
    expect(page.body).not.toContain('data-dsh-element-picker-bridge')
  })

  it('sends no cookie or referer upstream', async () => {
    let headers: Headers | undefined
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } })
    }) as typeof globalThis.fetch
    await fetchProxiedPage(new URL('https://example.com/'), { fetch, limit: LIMIT })
    expect(headers?.get('cookie')).toBeNull()
    expect(headers?.get('referer')).toBeNull()
    expect(headers?.get('authorization')).toBeNull()
    expect(headers?.get('accept')).toContain('text/html')
  })

  it('forwards the framing browser identity so upstream serves the real page', async () => {
    let sent: Headers | undefined
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers)
      return new Response('<html><head></head><body>x</body></html>', { headers: { 'content-type': 'text/html' } })
    }) as typeof globalThis.fetch
    await fetchProxiedPage(new URL('https://example.com/'), {
      fetch,
      limit: LIMIT,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36',
      acceptLanguage: 'de-DE,de;q=0.9',
    })
    expect(sent?.get('user-agent')).toBe('Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36')
    expect(sent?.get('accept-language')).toBe('de-DE,de;q=0.9')
  })

  it('falls back to a real browser UA (an unknown agent gets a JS-only stub)', async () => {
    let sent: Headers | undefined
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers)
      return new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } })
    }) as typeof globalThis.fetch
    await fetchProxiedPage(new URL('https://example.com/'), { fetch, limit: LIMIT })
    expect(sent?.get('user-agent')).toBe(PROXY_FALLBACK_USER_AGENT)
    expect(PROXY_FALLBACK_USER_AGENT).toContain('Chrome/')
  })

  it('surfaces the real reason behind node bare "fetch failed"', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND www.example.com'), { code: 'ENOTFOUND' })
    const wrapped = Object.assign(new TypeError('fetch failed'), { cause })
    const described = describeFetchError(wrapped)
    expect(described).toContain('fetch failed')
    expect(described).toContain('ENOTFOUND')
    expect(describeFetchError(new Error('boom'))).toBe('boom')
    expect(describeFetchError('nope')).toBe('nope')
  })

  it('reports the cause chain in the served error document', async () => {
    const fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
      })
    }) as typeof globalThis.fetch
    const page = await fetchProxiedPage(new URL('https://example.com/'), { fetch, limit: LIMIT })
    expect(page.status).toBe(502)
    expect(page.body).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  })
})
