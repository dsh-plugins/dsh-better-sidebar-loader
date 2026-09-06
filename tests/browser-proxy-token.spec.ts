/**
 * Proxy capability-token specs: the token is stable per process, and the
 * comparison refuses everything else (the sandboxed frame's navigation is
 * authorized by this token alone once the cross-site fence has refused it).
 */
import { describe, expect, it } from 'vitest'
import { isPickerProxyToken, pickerProxyToken } from '../src/browser-proxy-token.ts'
import { PROXY_ROUTE_PREFIX, encodeProxyUrl, proxyRequestToken } from '../src/browser-proxy.ts'

describe('picker proxy token', () => {
  it('mints one stable 64-hex token per process', () => {
    const token = pickerProxyToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(pickerProxyToken()).toBe(token)
  })

  it('accepts only the exact token', () => {
    const token = pickerProxyToken()
    expect(isPickerProxyToken(token)).toBe(true)
    expect(isPickerProxyToken(null)).toBe(false)
    expect(isPickerProxyToken(undefined)).toBe(false)
    expect(isPickerProxyToken('')).toBe(false)
    expect(isPickerProxyToken('a'.repeat(64))).toBe(false)
    expect(isPickerProxyToken(token.slice(0, 63))).toBe(false)
    expect(isPickerProxyToken(token + '0')).toBe(false)
    expect(isPickerProxyToken(token.slice(0, 63) + (token.endsWith('0') ? '1' : '0'))).toBe(false)
  })

  it('rides the route URL and reads back verbatim', () => {
    const token = pickerProxyToken()
    const url = encodeProxyUrl('https://example.com/a?b=1', token)
    expect(url).toContain('&t=' + token)
    expect(proxyRequestToken(url)).toBe(token)
    expect(isPickerProxyToken(proxyRequestToken(url))).toBe(true)
  })

  it('reads no token from a plain route URL', () => {
    expect(proxyRequestToken(encodeProxyUrl('https://example.com/'))).toBeNull()
    expect(proxyRequestToken(PROXY_ROUTE_PREFIX + '?url=x&t=')).toBe('')
    expect(isPickerProxyToken(proxyRequestToken(PROXY_ROUTE_PREFIX + '?url=x'))).toBe(false)
  })

  it('keeps the target intact next to the token', () => {
    const url = encodeProxyUrl('https://example.com/a?b=1&c=2#d', pickerProxyToken())
    const params = new URL(url, 'http://dsh.internal').searchParams
    expect(params.get('url')).toBe('https://example.com/a?b=1&c=2#d')
  })
})
