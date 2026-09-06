/**
 * The element-picker BRIDGE: the script this plugin injects into the HTML
 * documents it serves (/sidebar/html), and the injector that puts it there.
 *
 * The bridge is the in-frame half of the picker (see element-picker.ts for the
 * protocol and the reason a message bridge is the only option): it installs a
 * dormant message listener at load, answers the parent's ping with `ready`,
 * and on `start` takes over the document — crosshair cursor, a highlight
 * overlay following the pointer, a floating info popover (tag, size, color,
 * background, font), click to capture, Esc to cancel — then posts the captured
 * element back and restores the page exactly as it was. Nothing runs until the
 * parent asks: an untouched preview only carries the dormant listener.
 *
 * The picker body is authored as a normal typed function and serialized with
 * `Function.prototype.toString()` (the same technique ZCode uses for its
 * Electron `executeJavaScript` payload), so it MUST stay self-contained: no
 * imports, no module-scope references, no closure over anything but its own
 * parameters. Type-only imports are erased and therefore allowed.
 *
 * Host-only module (the client half never needs the payload); the injector is
 * pure string math so the unit tests cover it directly.
 */
import { PICKER_CHANNEL } from './element-picker.ts'
import type { PickedElement, PickedElementStyle, PickerConfig } from './element-picker.ts'

/**
 * The in-frame picker. Serialized to source and injected into served
 * documents — keep it self-contained (see the module doc).
 * @param channel - the postMessage channel name ({@link PICKER_CHANNEL}).
 */
function elementPickerBridge(channel: string): void {
  const installFlag = '__dshElementPickerInstalled'
  const globals = window as unknown as Record<string, unknown>
  if (globals[installFlag] === true) return
  globals[installFlag] = true

  /** Post one message to the embedder (no-op for a top-level document). */
  const post = (message: unknown): void => {
    const embedder = window.parent
    if (embedder !== window) embedder.postMessage(message, '*')
  }

  /**
   * Opaque-origin survival kit. Every document this plugin serves runs under a
   * sandbox WITHOUT allow-same-origin, where touching localStorage /
   * sessionStorage throws SecurityError. A proxied site whose first inline
   * script reads storage would abort before painting anything — the blank frame
   * users see. This script is injected at the very top of <head>, so replacing
   * the throwing accessors with in-memory stand-ins here lets the page's own
   * scripts run. Storage that already works is left completely alone.
   */
  const shimStorage = (name: string): void => {
    try {
      const existing = globals[name] as Storage | undefined
      if (existing !== undefined && existing !== null) {
        existing.getItem('__dshPickerProbe')
        return
      }
    } catch {
      // SecurityError: the opaque origin has no storage — fall through.
    }
    const entries = new Map<string, string>()
    const shim = {
      getItem: (key: string): string | null => entries.has(String(key)) ? entries.get(String(key)) as string : null,
      setItem: (key: string, value: string): void => { entries.set(String(key), String(value)) },
      removeItem: (key: string): void => { entries.delete(String(key)) },
      clear: (): void => { entries.clear() },
      key: (index: number): string | null => Array.from(entries.keys())[index] ?? null,
      get length(): number { return entries.size },
    }
    try {
      Object.defineProperty(window, name, { configurable: true, value: shim })
    } catch {
      // A locked-down accessor: nothing more this script can do.
    }
  }
  shimStorage('localStorage')
  shimStorage('sessionStorage')

  /** Collapse whitespace and truncate to `limit` characters. */
  const condense = (value: string | null | undefined, limit: number): string => {
    const text = (value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > limit ? text.slice(0, limit) + '...' : text
  }

  /** #RRGGBB of one 0-255 triple. */
  const hexOf = (r: number, g: number, b: number): string => '#' + [r, g, b]
    .map(part => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0'))
    .join('').toUpperCase()

  /** Normalize a computed rgb()/rgba() color to #RRGGBB ('transparent' when invisible). */
  const normalizeColor = (value: string): string => {
    const text = value.trim()
    const match = /^rgba?\(\s*([0-9.]+)(?:,|\s)+([0-9.]+)(?:,|\s)+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(text)
    if (match === null) return text
    const parts = [match[1], match[2], match[3]].map(part => Number(part))
    const rawAlpha = match[4]
    const alpha = rawAlpha === undefined
      ? 1
      : rawAlpha.endsWith('%') ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha)
    if (parts.some(part => Number.isNaN(part)) || Number.isNaN(alpha)) return text
    if (alpha <= 0) return 'transparent'
    return hexOf(parts[0] as number, parts[1] as number, parts[2] as number)
  }

  /** The captured computed style rows of one element. */
  const styleOf = (element: Element): PickedElementStyle => {
    const computed = window.getComputedStyle(element)
    const background = normalizeColor(computed.backgroundColor)
    const style: PickedElementStyle = {
      color: normalizeColor(computed.color),
      display: computed.display,
      fontFamily: condense(computed.fontFamily, 160),
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
    }
    if (background !== 'transparent') style.backgroundColor = background
    return style
  }

  /** Whether the element paints a visible background (popover row gate). */
  const paintsBackground = (style: PickedElementStyle): boolean =>
    style.backgroundColor !== undefined && style.backgroundColor !== 'transparent'

  /** 320x48 — the highlighted rectangle's rounded size. */
  const sizeLabel = (rect: DOMRect): string => Math.round(rect.width) + 'x' + Math.round(rect.height)

  /** CSS.escape with a conservative fallback. */
  const escapeIdentifier = (value: string): string => {
    const escape = window.CSS !== undefined ? window.CSS.escape : undefined
    return escape !== undefined ? escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }

  /** The element's own text — never a password value, never a typed-in value. */
  const textOf = (element: Element, limit: number): string => {
    if (element instanceof HTMLInputElement) {
      if (element.type.toLowerCase() === 'password') return '[masked password input]'
      return condense(element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? element.name ?? element.type, limit)
    }
    if (element instanceof HTMLTextAreaElement) {
      return condense(element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? element.name ?? 'textarea', limit)
    }
    const host = element as HTMLElement
    return condense(host.innerText !== undefined ? host.innerText : element.textContent, limit)
  }

  /** The implicit ARIA role of a tag (only the unambiguous mappings). */
  const inferredRole = (element: Element): string => {
    const tag = element.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : ''
    if (tag === 'img') return 'img'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'form') return 'form'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'range') return 'slider'
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
      return 'textbox'
    }
    return ''
  }

  /** The accessible name (aria-labelledby > aria-label > alt/title/placeholder > text). */
  const accessibleNameOf = (element: Element, limit: number): string => {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const joined = condense(labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent ?? '')
        .join(' '), limit)
      if (joined !== '') return joined
    }
    const direct = element.getAttribute('aria-label')
      ?? element.getAttribute('alt')
      ?? element.getAttribute('title')
      ?? element.getAttribute('placeholder')
    return condense(direct ?? textOf(element, limit), limit)
  }

  /** The whitelisted attributes of one element (never a live `value`). */
  const attributesOf = (element: Element, limit: number): Record<string, string> => {
    const kept: Record<string, string> = {}
    const allowed = ['id', 'class', 'href', 'src', 'alt', 'title', 'name', 'type', 'placeholder']
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name === 'value') continue
      if (!allowed.includes(name) && !name.startsWith('aria-') && !name.startsWith('data-')) continue
      kept[name] = condense(attribute.value, limit)
    }
    return kept
  }

  /** An id-anchored CSS path (at most 8 hops) that re-selects the element. */
  const cssPathOf = (element: Element): string => {
    if (element.id !== '') return '#' + escapeIdentifier(element.id)
    const hops: string[] = []
    let node: Element | null = element
    while (node !== null && node.nodeType === Node.ELEMENT_NODE && hops.length < 8) {
      const current: Element = node
      const tag = current.tagName.toLowerCase()
      if (current.id !== '') {
        hops.unshift(tag + '#' + escapeIdentifier(current.id))
        break
      }
      let hop = tag + Array.from(current.classList).filter(name => name !== '').slice(0, 2)
        .map(name => '.' + escapeIdentifier(name)).join('')
      const parent: Element | null = current.parentElement
      if (parent !== null) {
        const twins = Array.from(parent.children).filter(child => child.tagName === current.tagName)
        if (twins.length > 1) hop += ':nth-of-type(' + (twins.indexOf(current) + 1) + ')'
      }
      hops.unshift(hop)
      node = parent
    }
    return hops.join(' > ')
  }

  /** A positional XPath (at most 12 hops) — the fallback locator. */
  const xpathOf = (element: Element): string => {
    const hops: string[] = []
    let node: Element | null = element
    while (node !== null && node.nodeType === Node.ELEMENT_NODE && hops.length < 12) {
      const current: Element = node
      const tag = current.tagName.toLowerCase()
      const parent: Element | null = current.parentElement
      if (parent === null) {
        hops.unshift('/' + tag)
        break
      }
      const index = Array.from(parent.children).filter(child => child.tagName === current.tagName).indexOf(current) + 1
      hops.unshift(tag + '[' + index + ']')
      node = parent
    }
    return ('/' + hops.join('/')).replace(/^\/\//, '/')
  }

  /** Text of the nearest meaningful container (the element's context). */
  const nearbyTextOf = (element: Element, limit: number): string => {
    const container = element.closest('article, section, main, form, li, tr, dialog') ?? element.parentElement ?? element
    const host = container as HTMLElement
    return condense(host.innerText !== undefined ? host.innerText : container.textContent, limit)
  }

  /**
   * Sanitized outerHTML: scripts/styles dropped and every field's typed-in
   * value stripped — including the CLONE ROOT itself (querySelectorAll only
   * walks descendants, so picking an input directly would otherwise leak its
   * `value` attribute straight into the chat).
   */
  const htmlExcerptOf = (element: Element, limit: number): string => {
    const clone = element.cloneNode(true)
    if (!(clone instanceof Element)) return ''
    for (const dropped of Array.from(clone.querySelectorAll('script, style, noscript, template'))) dropped.remove()
    const stripValue = (field: Element): void => {
      if (field instanceof HTMLInputElement) field.removeAttribute('value')
      if (field instanceof HTMLTextAreaElement) field.textContent = ''
    }
    stripValue(clone)
    for (const field of Array.from(clone.querySelectorAll('input, textarea'))) stripValue(field)
    return condense(clone.outerHTML, limit)
  }

  /** The full capture of one element. */
  const captureElement = (element: Element, config: PickerConfig): PickedElement => {
    const rect = element.getBoundingClientRect()
    const captured: PickedElement = {
      // The proxied case reports the REAL page, not the route serving it.
      pageUrl: typeof config.pageUrl === 'string' && config.pageUrl !== '' ? config.pageUrl : location.href,
      pageTitle: document.title,
      tagName: element.tagName.toLowerCase(),
      selector: cssPathOf(element),
      xpath: xpathOf(element),
      attributes: attributesOf(element, config.maxAttributeChars),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: styleOf(element),
      capturedAt: Date.now(),
    }
    const role = element.getAttribute('role') ?? inferredRole(element)
    if (role !== null && role !== '') captured.role = role
    const name = accessibleNameOf(element, config.maxTextChars)
    if (name !== '') captured.accessibleName = name
    const text = textOf(element, config.maxTextChars)
    if (text !== '') captured.text = text
    const nearby = nearbyTextOf(element, config.maxTextChars)
    if (nearby !== '') captured.nearbyText = nearby
    const html = htmlExcerptOf(element, config.maxHtmlChars)
    if (html !== '') captured.htmlExcerpt = html
    return captured
  }

  /** The live picking session (null while dormant). */
  let session: { requestId: string; stop: (status: 'selected' | 'cancelled', element?: PickedElement) => void } | null = null

  /** Start one picking session; it answers the parent through `post`. */
  const startSession = (requestId: string, config: PickerConfig): void => {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-dsh-element-picker', 'overlay')
    Object.assign(overlay.style, {
      background: 'rgba(37, 99, 235, 0.12)',
      border: '2px solid #2563eb',
      borderRadius: '4px',
      boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.10)',
      boxSizing: 'border-box',
      display: 'none',
      left: '0',
      pointerEvents: 'none',
      position: 'fixed',
      top: '0',
      zIndex: '2147483647',
    })
    const popover = document.createElement('div')
    popover.setAttribute('data-dsh-element-picker', 'popover')
    Object.assign(popover.style, {
      background: 'rgba(17, 24, 39, 0.94)',
      border: '1px solid rgba(255, 255, 255, 0.14)',
      borderRadius: '10px',
      boxShadow: '0 12px 28px rgba(15, 23, 42, 0.28)',
      boxSizing: 'border-box',
      color: '#f9fafb',
      display: 'none',
      font: '12px/1.5 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
      left: '0',
      maxWidth: 'calc(100vw - 16px)',
      minWidth: '180px',
      padding: '8px 12px',
      pointerEvents: 'none',
      position: 'fixed',
      top: '0',
      width: 'min(300px, calc(100vw - 16px))',
      zIndex: '2147483647',
    })
    document.documentElement.append(overlay, popover)
    const previousCursor = document.documentElement.style.cursor
    document.documentElement.style.cursor = 'crosshair'

    let hovered: Element | null = null

    /** One label/value row of the popover. */
    const addRow = (label: string, value: string | undefined, strong: boolean): void => {
      if (value === undefined || value === '') return
      const row = document.createElement('div')
      Object.assign(row.style, {
        alignItems: 'baseline',
        columnGap: '12px',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        minWidth: '0',
      })
      const key = document.createElement('span')
      key.textContent = label
      Object.assign(key.style, {
        color: strong ? '#ffffff' : 'rgba(255, 255, 255, 0.62)',
        fontWeight: strong ? '700' : '600',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      })
      const text = document.createElement('span')
      text.textContent = value
      Object.assign(text.style, {
        color: '#ffffff',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontWeight: strong ? '700' : '500',
        overflow: 'hidden',
        textAlign: 'right',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      })
      row.append(key, text)
      popover.append(row)
    }

    /** Clamp a coordinate into [min, max]. */
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

    /** Place the popover beside the highlight, inside the viewport. */
    const placePopover = (rect: DOMRect): void => {
      const width = popover.offsetWidth !== 0 ? popover.offsetWidth : 220
      const height = popover.offsetHeight !== 0 ? popover.offsetHeight : 80
      const maxLeft = Math.max(8, window.innerWidth - width - 8)
      const maxTop = Math.max(8, window.innerHeight - height - 8)
      const centeredLeft = clamp(rect.left + rect.width / 2 - width / 2, 8, maxLeft)
      const below = rect.bottom + 12
      const above = rect.top - height - 12
      const top = below + height <= window.innerHeight - 8 ? below : above >= 8 ? above : clamp(below, 8, maxTop)
      popover.style.left = centeredLeft + 'px'
      popover.style.top = top + 'px'
    }

    /** Highlight one element (or hide the chrome when it is not pickable). */
    const highlight = (element: Element | null): void => {
      if (element === null || element === overlay || element === popover) {
        overlay.style.display = 'none'
        popover.style.display = 'none'
        return
      }
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        overlay.style.display = 'none'
        popover.style.display = 'none'
        return
      }
      overlay.style.display = 'block'
      overlay.style.left = Math.max(0, rect.left) + 'px'
      overlay.style.top = Math.max(0, rect.top) + 'px'
      overlay.style.width = rect.width + 'px'
      overlay.style.height = rect.height + 'px'
      const style = styleOf(element)
      popover.replaceChildren()
      addRow(element.tagName.toLowerCase(), sizeLabel(rect), true)
      addRow(config.labels.color, style.color, false)
      if (paintsBackground(style)) addRow(config.labels.background, style.backgroundColor, false)
      addRow(config.labels.font, [style.fontSize, style.fontFamily].filter(part => part !== undefined && part !== '').join(' '), false)
      popover.style.display = 'block'
      placePopover(rect)
    }

    const onMove = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Element) {
        hovered = target
        highlight(target)
      }
    }
    const onClick = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (hovered === null) {
        stop('cancelled')
        return
      }
      stop('selected', captureElement(hovered, config))
    }
    /**
     * Esc leaves picking. Registered on BOTH window and document in the CAPTURE
     * phase, and mirrored on keyup: window-capture runs before anything the page
     * itself installed, so a site that listens for Escape and stops propagation
     * (search suggestion boxes do this constantly) can no longer swallow the way
     * out. The embedder keeps its own window-level Escape handler for the case
     * where the sidebar — not this document — owns focus.
     */
    const escapeOf = (event: KeyboardEvent): boolean => event.key === 'Escape' || event.key === 'Esc'
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!escapeOf(event)) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      stop('cancelled')
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      // Second chance: a page that cancels keydown outright rarely cancels keyup.
      if (escapeOf(event)) stop('cancelled')
    }
    const onScroll = (): void => { highlight(hovered) }

    /** Settle the session: restore the page, then answer the parent once. */
    function stop(status: 'selected' | 'cancelled', element?: PickedElement): void {
      if (session === null || session.requestId !== requestId) return
      session = null
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('scroll', onScroll, true)
      overlay.remove()
      popover.remove()
      document.documentElement.style.cursor = previousCursor
      post(element === undefined
        ? { channel, type: 'result', requestId, status }
        : { channel, type: 'result', requestId, status, element })
    }

    session = { requestId, stop }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('scroll', onScroll, true)
    // Keys only reach this document while it owns focus. A page that autofocuses
    // a nested frame (ads, embedded players, login widgets) would otherwise eat
    // Escape entirely, so focus is pulled back to this document at start.
    const active = document.activeElement
    if (active instanceof HTMLElement && (active.tagName === 'IFRAME' || active.tagName === 'FRAME')) active.blur()
    try {
      if (!document.hasFocus()) window.focus()
    } catch {
      // A frame that may not take focus: the document listeners still apply.
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    // Only the embedder may drive the picker: neither the page itself nor a
    // nested frame can start a capture.
    if (event.source !== window.parent || window.parent === window) return
    const message = event.data as { channel?: unknown; type?: unknown; requestId?: unknown; config?: unknown } | null
    if (typeof message !== 'object' || message === null || message.channel !== channel) return
    if (message.type === 'ping') {
      post({ channel, type: 'ready' })
      return
    }
    if (message.type === 'cancel') {
      if (session !== null && (message.requestId === undefined || session.requestId === message.requestId)) {
        session.stop('cancelled')
      }
      return
    }
    if (message.type !== 'start' || typeof message.requestId !== 'string') return
    session?.stop('cancelled')
    startSession(message.requestId, message.config as PickerConfig)
  })

  post({ channel, type: 'ready' })
}

/** The attribute marking the injected script tag (also the idempotence guard). */
export const PICKER_BRIDGE_MARKER = 'data-dsh-element-picker-bridge'

/**
 * The bridge as an executable script body: the picker function's own source,
 * invoked with the channel name. The function contains no `</script`
 * literal, but the sequence is escaped defensively so no future edit can
 * close the injected tag early.
 */
export function pickerBridgeSource(): string {
  const body = '(' + elementPickerBridge.toString() + ')(' + JSON.stringify(PICKER_CHANNEL) + ');'
  return body.replace(/<\/script/gi, '<\\/script')
}

/**
 * Inject the bridge into one served HTML document: a single inline script
 * right after `<head>` (before the page's own scripts, so the listener
 * exists for the parent's first ping), falling back to the `<html>` tag
 * and finally to the document start. Already-injected markup is returned
 * untouched.
 * @param html - the document source as served.
 */
export function injectPickerBridge(html: string): string {
  if (html.includes(PICKER_BRIDGE_MARKER)) return html
  const tag = '<script ' + PICKER_BRIDGE_MARKER + '>' + pickerBridgeSource() + '</script>'
  const head = /<head[^>]*>/i.exec(html)
  if (head !== null) {
    const at = head.index + head[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  const root = /<html[^>]*>/i.exec(html)
  if (root !== null) {
    const at = root.index + root[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return tag + html
}
