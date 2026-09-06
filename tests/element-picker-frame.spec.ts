/**
 * In-frame bridge spec (jsdom): the injected picker payload really installs in
 * a framed document, answers the parent handshake, captures the clicked
 * element, honors Esc, and leaves the page exactly as it found it.
 *
 * The bridge is serialized function source, so this is the only test that
 * exercises it as the browser will: evaluated inside a real (jsdom) frame
 * realm. Parent->bridge messages are dispatched as MessageEvents with an
 * explicit `source` (jsdom's cross-frame postMessage does not populate it
 * reliably); bridge->parent messages go through the real postMessage path.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PICKER_CHANNEL, PICKER_DEFAULTS } from '../src/element-picker.ts'
import { pickerBridgeSource } from '../src/element-picker-bridge.ts'

/** One installed bridge inside a fresh frame, with the parent's inbox. */
interface Harness {
  frameWindow: Window & typeof globalThis
  inbox: Record<string, unknown>[]
  /** Dispatch one parent -> bridge message. */
  send: (message: Record<string, unknown>) => void
  /** Let the queued postMessage tasks land. */
  settle: () => Promise<void>
}

let harness: Harness | null = null

function install(markup: string): Harness {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const frameWindow = frame.contentWindow as (Window & typeof globalThis) | null
  if (frameWindow === null) throw new Error('no frame window')
  frameWindow.document.body.innerHTML = markup
  const inbox: Record<string, unknown>[] = []
  window.addEventListener('message', (event) => {
    inbox.push(event.data as Record<string, unknown>)
  })
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  frameWindow.eval(pickerBridgeSource())
  return {
    frameWindow,
    inbox,
    send: (message) => {
      frameWindow.dispatchEvent(new frameWindow.MessageEvent('message', { data: message, source: frameWindow.parent }))
    },
    settle: () => new Promise<void>((resolve) => { setTimeout(resolve, 0) }),
  }
}

/** Fire one mouse event of the frame's realm at a node. */
function mouse(target: Element, type: string, frameWindow: Window & typeof globalThis): void {
  target.dispatchEvent(new frameWindow.MouseEvent(type, { bubbles: true, cancelable: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  harness = null
  document.body.innerHTML = ''
})

describe('injected picker bridge (in a real frame)', () => {
  it('announces itself and answers the parent ping', async () => {
    harness = install('<main><button id="go">Go</button></main>')
    await harness.settle()
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'ready' }])
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'ping' })
    await harness.settle()
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'ready' }])
  })

  it('captures the clicked element and restores the document', async () => {
    harness = install('<main><section><button id="go" class="primary" type="submit" aria-label="Start trial">Start trial</button></section></main>')
    await harness.settle()
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    const button = harness.frameWindow.document.getElementById('go')!
    mouse(button, 'mousemove', harness.frameWindow)
    // Picking chrome is live while hovering...
    expect(harness.frameWindow.document.querySelectorAll('[data-dsh-element-picker]').length).toBe(2)
    expect(harness.frameWindow.document.documentElement.style.cursor).toBe('crosshair')
    mouse(button, 'click', harness.frameWindow)
    await harness.settle()
    expect(harness.inbox).toHaveLength(1)
    const result = harness.inbox[0] as { type: string; requestId: string; status: string; element: Record<string, unknown> }
    expect(result.type).toBe('result')
    expect(result.requestId).toBe('r1')
    expect(result.status).toBe('selected')
    expect(result.element.tagName).toBe('button')
    expect(result.element.selector).toBe('#go')
    expect(result.element.xpath).toBe('/html/body[1]/main[1]/section[1]/button[1]')
    expect(result.element.role).toBe('button')
    expect(result.element.accessibleName).toBe('Start trial')
    expect(result.element.text).toBe('Start trial')
    expect(result.element.attributes).toEqual({
      'aria-label': 'Start trial',
      class: 'primary',
      id: 'go',
      type: 'submit',
    })
    expect(result.element.htmlExcerpt).toContain('<button id="go"')
    // ...and gone afterwards: no overlay, no popover, original cursor.
    expect(harness.frameWindow.document.querySelectorAll('[data-dsh-element-picker]').length).toBe(0)
    expect(harness.frameWindow.document.documentElement.style.cursor).toBe('')
  })

  it('masks a password field instead of capturing its value', async () => {
    harness = install('<form><input id="pw" type="password" value="hunter2"></form>')
    await harness.settle()
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    const field = harness.frameWindow.document.getElementById('pw')!
    mouse(field, 'mousemove', harness.frameWindow)
    mouse(field, 'click', harness.frameWindow)
    await harness.settle()
    const element = (harness.inbox[0] as { element: Record<string, unknown> }).element
    expect(element.text).toBe('[masked password input]')
    // Neither the capture nor the HTML excerpt may carry the typed-in value.
    expect(element.htmlExcerpt).toBe('<input id="pw" type="password">')
    expect(JSON.stringify(element)).not.toContain('hunter2')
  })

  it('cancels on Esc and on the parent cancel message', async () => {
    harness = install('<main><button id="go">Go</button></main>')
    await harness.settle()
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    harness.frameWindow.document.dispatchEvent(new harness.frameWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await harness.settle()
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'cancelled' }])
    expect(harness.frameWindow.document.documentElement.style.cursor).toBe('')

    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r2', config: PICKER_DEFAULTS })
    harness.send({ channel: PICKER_CHANNEL, type: 'cancel', requestId: 'r2' })
    await harness.settle()
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'result', requestId: 'r2', status: 'cancelled' }])
  })

  it('leaves picking on Esc even when the page fights for the key', async () => {
    harness = install('<main><input id="q" /></main>')
    await harness.settle()
    const frameWindow = harness.frameWindow
    // A search box that eats Escape — the pattern that made Esc feel dead on
    // real sites: document-level capture plus stopImmediatePropagation.
    frameWindow.document.addEventListener('keydown', (event) => {
      event.stopImmediatePropagation()
      event.preventDefault()
    }, true)
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    // Focus inside the page, key delivered to the focused field.
    const field = frameWindow.document.getElementById('q') as HTMLInputElement
    field.focus()
    field.dispatchEvent(new frameWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await harness.settle()
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'cancelled' }])
    expect(frameWindow.document.querySelectorAll('[data-dsh-element-picker]').length).toBe(0)
  })

  it('accepts Esc on keyup when keydown never arrives', async () => {
    harness = install('<main><button id="go">Go</button></main>')
    await harness.settle()
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    harness.frameWindow.dispatchEvent(new harness.frameWindow.KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
    await harness.settle()
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'cancelled' }])
  })

  it('answers Esc dispatched at the window as well as the document', async () => {
    harness = install('<main><button id="go">Go</button></main>')
    await harness.settle()
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    harness.frameWindow.dispatchEvent(new harness.frameWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await harness.settle()
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'cancelled' }])
    // One answer only: the mirrored keyup handler must not post twice.
    harness.frameWindow.dispatchEvent(new harness.frameWindow.KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
    await harness.settle()
    expect(harness.inbox).toHaveLength(1)
  })

  it('ignores foreign channels and a non-embedder source', async () => {
    harness = install('<main><button id="go">Go</button></main>')
    await harness.settle()
    harness.inbox.length = 0
    // Wrong channel: no answer at all.
    harness.send({ channel: 'other', type: 'ping' })
    // Right channel, but the page itself is the sender (not the embedder).
    harness.frameWindow.dispatchEvent(new harness.frameWindow.MessageEvent('message', {
      data: { channel: PICKER_CHANNEL, type: 'start', requestId: 'evil', config: PICKER_DEFAULTS },
      source: harness.frameWindow,
    }))
    await harness.settle()
    expect(harness.inbox).toEqual([])
    // The rejected start installed nothing.
    expect(harness.frameWindow.document.querySelectorAll('[data-dsh-element-picker]').length).toBe(0)
  })

  it('a cancel with no request id stops whatever session is running', async () => {
    harness = install('<main><p id="t">text</p></main>')
    await harness.settle()
    harness.inbox.length = 0
    harness.send({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    expect(harness.frameWindow.document.querySelectorAll('[data-dsh-element-picker]').length).toBeGreaterThan(0)
    // The parent sends this after a frame load: the document may still hold a
    // session whose id the parent dropped during the reset, so the cancel must
    // work without one.
    harness.send({ channel: PICKER_CHANNEL, type: 'cancel' })
    await harness.settle()
    expect(harness.frameWindow.document.querySelectorAll('[data-dsh-element-picker]').length).toBe(0)
    expect(harness.inbox).toEqual([{ channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'cancelled' }])
  })
})
