/**
 * Element-picker UI spec: both web surfaces render the "选择网页元素加入聊天"
 * toggle, and it starts DISABLED with the cross-origin explanation until the
 * framed document's bridge answers the ready handshake (which cannot happen
 * during a server render — the pinned copy is the honest "not here" state a
 * user sees on a remote site).
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import './browser-globals.ts'
import type { Context } from '../src/context-types.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { BrowserView } from '../src/client/BrowserView.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

const CTX = {} as Context

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

function viewerProps(store: ReturnType<typeof createSidebarStore>, overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store,
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a/index.html',
    title: 'index.html',
    viewerId: 'html',
    content: '<h1>hi</h1>',
    ...overrides,
  }
}

function tabProps(store: ReturnType<typeof createSidebarStore>, path?: string) {
  return {
    ctx: CTX,
    store,
    scope: { sessionId: 's1', cwd: '/p' },
    tab: { id: 'browser:1', type: 'browser', title: 'Browser', ...(path !== undefined ? { path } : {}) },
    visible: true,
  }
}

describe('element picker toggle (browser tab)', () => {
  it('offers the proxy route for a remote page (a remote frame has no bridge)', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(BrowserView, tabProps(store, 'https://example.com/')))
    expect(html).toContain('aria-label="' + zh.pickElement + '"')
    // No bridge can answer on a remote origin, but the page IS proxyable, so the
    // action stays available and explains what pressing it will do.
    expect(html).toContain('title="' + zh.pickElementViaProxy + '"')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain(zh.pickElementCancel)
    expect(html).not.toContain(zh.browserProxyNotice)
  })

  it('disables the toggle for a page the proxy refuses (loopback)', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(BrowserView, tabProps(store, 'http://127.0.0.1:8080/')))
    expect(html).toContain('title="' + zh.pickElementUnsupported + '" disabled=""')
  })

  it('stays disabled before any navigation', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(BrowserView, tabProps(store)))
    expect(html).toContain('aria-label="' + zh.pickElement + '"')
    expect(html).toContain('title="' + zh.pickElementUnsupported + '" disabled=""')
  })
})

describe('element picker toggle (HTML preview)', () => {
  it('renders over the preview iframe, disabled until the injected bridge answers', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(TextEditor, viewerProps(store)))
    expect(html).toContain('<iframe')
    expect(html).toContain('aria-label="' + zh.pickElement + '"')
    expect(html).toContain('title="' + zh.pickElementUnsupported + '" disabled=""')
  })

  it('is absent for a markdown viewer (no framed document to pick in)', () => {
    const store = createSidebarStore()
    const html = renderToString(createElement(TextEditor, viewerProps(store, {
      viewerId: 'markdown',
      path: '/p/readme.md',
      content: '# hi',
    })))
    expect(html).not.toContain(zh.pickElement)
  })
})
