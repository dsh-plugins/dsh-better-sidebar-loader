/**
 * Element-picker proxy specs: the route's URL vocabulary, its fetch policy
 * (the SSRF fence that also re-runs on every redirect hop), the charset sniff,
 * and the HTML rewrite that makes a remote page pickable inside the GUI's
 * origin.
 */
import { describe, expect, it } from 'vitest'
import {
  PROXY_ROUTE_PREFIX,
  charsetOf,
  decodeProxyRequest,
  encodeProxyUrl,
  isInternalHostname,
  isProxyablePage,
  proxyErrorDocument,
  proxyPolicy,
  proxyRequestNoScript,
  proxyRequestToken,
  rewriteProxiedHtml,
} from '../src/browser-proxy.ts'
import { injectPickerBridge } from '../src/element-picker-bridge.ts'

describe('proxy url vocabulary', () => {
  it('round-trips one target through the route URL', () => {
    const encoded = encodeProxyUrl('https://example.com/a?b=1#c')
    expect(encoded.startsWith(PROXY_ROUTE_PREFIX + '?url=')).toBe(true)
    const decoded = decodeProxyRequest(encoded)
    expect(decoded.ok).toBe(true)
    expect(decoded.ok && decoded.target.href).toBe('https://example.com/a?b=1#c')
  })

  it('refuses a request without a target', () => {
    expect(decodeProxyRequest(PROXY_ROUTE_PREFIX)).toEqual({ ok: false, status: 400, message: 'url is required' })
    expect(decodeProxyRequest(PROXY_ROUTE_PREFIX + '?url=')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('proxy fetch policy', () => {
  it('accepts public http(s) pages', () => {
    expect(proxyPolicy('https://example.com/').ok).toBe(true)
    expect(proxyPolicy('http://8.8.8.8/status').ok).toBe(true)
    expect(proxyPolicy('https://172.15.0.1/').ok).toBe(true)
    expect(proxyPolicy('https://[2606:4700::1111]/').ok).toBe(true)
  })

  it('refuses non-http schemes and unparsable input', () => {
    expect(proxyPolicy('file:///etc/passwd')).toMatchObject({ ok: false, status: 400 })
    expect(proxyPolicy('data:text/html,<b>x')).toMatchObject({ ok: false, status: 400 })
    expect(proxyPolicy('not a url')).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses the local machine and private / link-local literals', () => {
    for (const target of [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://127.0.0.1:8080/',
      'http://127.9.9.9/',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.0.1/',
      'http://[::1]:9000/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]) {
      expect(proxyPolicy(target), target).toMatchObject({ ok: false, status: 403 })
    }
  })

  it('classifies hostnames the same way through the exported predicate', () => {
    expect(isInternalHostname('127.0.0.1')).toBe(true)
    expect(isInternalHostname('LOCALHOST')).toBe(true)
    expect(isInternalHostname('172.32.0.1')).toBe(false)
    expect(isInternalHostname('example.com')).toBe(false)
  })

  it('gates the client toggle on the same policy', () => {
    expect(isProxyablePage(undefined)).toBe(false)
    expect(isProxyablePage('')).toBe(false)
    expect(isProxyablePage('http://localhost/')).toBe(false)
    expect(isProxyablePage('https://example.com/')).toBe(true)
  })
})

describe('charset sniff', () => {
  it('prefers the response header, then the document metas, then utf-8', () => {
    expect(charsetOf('text/html; charset=GBK', '<meta charset="utf-8">')).toBe('gbk')
    expect(charsetOf('text/html', '<meta charset="Big5">')).toBe('big5')
    expect(charsetOf(null, '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">')).toBe('gb2312')
    expect(charsetOf(null, '<html><head></head>')).toBe('utf-8')
  })
})

describe('proxied html rewrite', () => {
  const page = 'https://example.com/docs/guide.html'

  it('inserts a base tag so relative references resolve at the real origin', () => {
    const out = rewriteProxiedHtml('<!doctype html><html><head><title>t</title></head><body>x</body></html>', page)
    expect(out).toContain('<head><base href="https://example.com/docs/guide.html">')
    expect(out).toContain('<title>t</title>')
  })

  it('absolutizes an existing relative base against the real page', () => {
    const out = rewriteProxiedHtml('<html><head><base href="/assets/"></head></html>', page)
    expect(out).toContain('<base href="https://example.com/assets/">')
    expect(out.match(/<base/g)).toHaveLength(1)
  })

  it('keeps an already absolute base', () => {
    const out = rewriteProxiedHtml('<html><head><base href=\'https://cdn.example.net/x/\'></head></html>', page)
    expect(out).toContain('<base href="https://cdn.example.net/x/">')
  })

  it('drops the page CSP and charset declarations that would fight the route', () => {
    const source = [
      '<html><head>',
      '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">',
      '<meta http-equiv="content-type" content="text/html; charset=gbk">',
      '<meta charset="gbk">',
      '</head><body>x</body></html>',
    ].join('')
    const out = rewriteProxiedHtml(source, page)
    expect(out).not.toContain('Content-Security-Policy')
    expect(out).not.toContain('charset=gbk')
    expect(out).not.toContain('<meta charset')
  })

  it('supplies a head for markup that has none', () => {
    expect(rewriteProxiedHtml('<html><body>x</body></html>', page)).toContain('<html><head><base href="https://example.com/docs/guide.html"></head>')
    expect(rewriteProxiedHtml('<p>fragment</p>', page)).toBe('<head><base href="https://example.com/docs/guide.html"></head><p>fragment</p>')
  })

  it('escapes the page url into the attribute', () => {
    const out = rewriteProxiedHtml('<html><head></head></html>', 'https://example.com/?a="b"&c=<d>')
    expect(out).toContain('<base href="https://example.com/?a=&quot;b&quot;&amp;c=&lt;d&gt;">')
  })

  it('composes with the bridge injection: one script, one base', () => {
    const served = injectPickerBridge(rewriteProxiedHtml('<html><head><title>t</title></head><body>x</body></html>', page))
    expect(served.match(/<script /g)).toHaveLength(1)
    expect(served.match(/<base /g)).toHaveLength(1)
    expect(served).toContain('data-dsh-element-picker-bridge')
    expect(served).toContain('<base href="https://example.com/docs/guide.html">')
  })
})

describe('proxy error document', () => {
  it('is a standalone html page with the reason escaped', () => {
    const out = proxyErrorDocument('nope <script>alert(1)</script> & done')
    expect(out.startsWith('<!doctype html>')).toBe(true)
    expect(out).toContain('nope &lt;script&gt;alert(1)&lt;/script&gt; &amp; done')
    expect(out).not.toContain('<script>')
    // No bridge: the crosshair must stay unavailable on a failed proxy load.
    expect(out).not.toContain('data-dsh-element-picker-bridge')
  })
})

describe('static (script-free) mode', () => {
  const page = 'https://example.com/'

  it('drops the page own scripts but keeps the markup', () => {
    const source = '<html><head><script src="/a.js"></script><script>location.replace("https://example.com/real")</script></head><body><h1>hi</h1><script defer>x()</script></body></html>'
    const out = rewriteProxiedHtml(source, page, true)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('location.replace')
    expect(out).toContain('<h1>hi</h1>')
    expect(out).toContain('<base href="https://example.com/">')
  })

  it('keeps the scripts in normal mode', () => {
    const out = rewriteProxiedHtml('<html><head><script>x()</script></head></html>', page)
    expect(out).toContain('<script>x()</script>')
  })

  it('still admits the injected bridge afterwards', () => {
    const served = injectPickerBridge(rewriteProxiedHtml('<html><head><script>bust()</script></head><body>x</body></html>', page, true))
    expect(served).toContain('data-dsh-element-picker-bridge')
    expect(served).not.toContain('bust()')
    expect(served.match(/<script /g)).toHaveLength(1)
  })

  it('rides the route URL as noscript=1 and is read back', () => {
    const url = encodeProxyUrl(page, 'tok', true)
    expect(url).toContain('noscript=1')
    expect(proxyRequestNoScript(url)).toBe(true)
    expect(proxyRequestNoScript(encodeProxyUrl(page, 'tok'))).toBe(false)
    expect(proxyRequestToken(url)).toBe('tok')
  })
})
