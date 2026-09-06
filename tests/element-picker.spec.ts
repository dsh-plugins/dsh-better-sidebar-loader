/**
 * Element-picker specs: the pure halves of the "选择网页元素加入聊天" feature —
 * the postMessage protocol validators, the model-facing insert block, the
 * bridge injection into served HTML, and the parent-side controller state
 * machine (driven with fake frames, no DOM required).
 */
import { describe, expect, it } from 'vitest'
import {
  PICKER_CHANNEL,
  PICKER_DEFAULTS,
  buildWebElementInsert,
  cancelMessage,
  countWebElementBlocks,
  isReadyMessage,
  pingMessage,
  readResultMessage,
  startMessage,
} from '../src/element-picker.ts'
import type { PickedElement } from '../src/element-picker.ts'
import { PICKER_BRIDGE_MARKER, injectPickerBridge, pickerBridgeSource } from '../src/element-picker-bridge.ts'
import { createElementPickerController } from '../src/client/element-picker.ts'
import type { ElementPickerState, PickerTarget } from '../src/client/element-picker.ts'

/** A fully populated picked element (the insert-format fixture). */
function element(overrides: Partial<PickedElement> = {}): PickedElement {
  return {
    pageUrl: 'https://example.com/pricing?plan=pro',
    pageTitle: 'Pricing',
    tagName: 'button',
    role: 'button',
    accessibleName: 'Start trial',
    selector: '#app > form.signup > button.primary',
    xpath: '/html/body/div[1]/form[1]/button[1]',
    text: 'Start trial',
    nearbyText: 'Pro plan  $20/mo  Start trial',
    htmlExcerpt: '<button class="primary">Start trial</button>',
    attributes: { class: 'primary', type: 'submit' },
    rect: { x: 12.4, y: 340.6, width: 88.2, height: 32 },
    style: {
      color: '#FFFFFF',
      backgroundColor: '#2563EB',
      fontFamily: 'Inter, sans-serif',
      fontSize: '14px',
      fontWeight: '600',
      display: 'inline-flex',
    },
    capturedAt: 1710000000000,
    ...overrides,
  }
}

/** A frame stand-in recording everything the controller posts into it. */
function fakeFrame(): { target: PickerTarget; posted: unknown[] } {
  const posted: unknown[] = []
  const target: PickerTarget = { postMessage: (message) => { posted.push(message) } }
  return { target, posted }
}

/** A controller wired to one fake frame with deterministic request ids. */
function harness(options: { ready?: boolean } = {}) {
  const frame = fakeFrame()
  let attached = true
  const states: ElementPickerState[] = []
  const picked: PickedElement[] = []
  let counter = 0
  const sessionEnds: number[] = []
  const controller = createElementPickerController({
    target: () => (attached ? frame.target : null),
    config: () => PICKER_DEFAULTS,
    copy: () => ({ hint: 'hint', unsupported: 'unsupported' }),
    onState: state => { states.push(state) },
    onPicked: value => { picked.push(value) },
    onSessionEnd: () => { sessionEnds.push(frame.posted.length) },
    newRequestId: () => 'req-' + String(++counter),
  })
  if (options.ready === true) {
    controller.handleMessage({ source: frame.target, data: { channel: PICKER_CHANNEL, type: 'ready' } })
  }
  return {
    controller,
    frame,
    picked,
    states,
    sessionEnds,
    detach: () => { attached = false },
  }
}

describe('picker protocol messages', () => {
  it('builds ping / start / cancel on the shared channel', () => {
    expect(pingMessage()).toEqual({ channel: PICKER_CHANNEL, type: 'ping' })
    expect(startMessage('r1')).toEqual({ channel: PICKER_CHANNEL, type: 'start', requestId: 'r1', config: PICKER_DEFAULTS })
    expect(cancelMessage('r1')).toEqual({ channel: PICKER_CHANNEL, type: 'cancel', requestId: 'r1' })
  })

  it('recognizes only the bridge ready announcement', () => {
    expect(isReadyMessage({ channel: PICKER_CHANNEL, type: 'ready' })).toBe(true)
    expect(isReadyMessage({ channel: 'other', type: 'ready' })).toBe(false)
    expect(isReadyMessage({ channel: PICKER_CHANNEL, type: 'result' })).toBe(false)
    expect(isReadyMessage(null)).toBe(false)
    expect(isReadyMessage('ready')).toBe(false)
  })

  it('accepts a well-formed result for the live request only', () => {
    const message = { channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'selected', element: element() }
    expect(readResultMessage(message, 'r1')?.element?.tagName).toBe('button')
    // A stale request id, a foreign channel and a wrong type are all ignored.
    expect(readResultMessage(message, 'r2')).toBeNull()
    expect(readResultMessage({ ...message, channel: 'x' }, 'r1')).toBeNull()
    expect(readResultMessage({ ...message, type: 'ready' }, 'r1')).toBeNull()
    expect(readResultMessage(undefined, 'r1')).toBeNull()
  })

  it('keeps the cancelled status without an element', () => {
    const result = readResultMessage({ channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'cancelled' }, 'r1')
    expect(result).toEqual({ channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'cancelled' })
  })

  it('rejects an element payload missing its identity fields', () => {
    const base = { channel: PICKER_CHANNEL, type: 'result', requestId: 'r1', status: 'selected' }
    expect(readResultMessage({ ...base, element: { pageUrl: 'https://x/', tagName: 'div' } }, 'r1')).toBeNull()
    expect(readResultMessage({ ...base, element: { tagName: 'div', selector: 'div' } }, 'r1')).toBeNull()
    expect(readResultMessage({ ...base, element: null }, 'r1')).toBeNull()
  })

  it('normalizes an untrusted payload (types coerced, junk dropped)', () => {
    const result = readResultMessage({
      channel: PICKER_CHANNEL,
      type: 'result',
      requestId: 'r1',
      status: 'selected',
      element: {
        pageUrl: 'https://example.com/',
        pageTitle: 42,
        tagName: 'DIV',
        selector: '#a',
        text: 7,
        attributes: { id: 'a', bad: { nested: true } },
        rect: { x: 'nope', y: 4, width: 10, height: 20 },
        style: { color: '#FFF', fontWeight: 700 },
        capturedAt: 'soon',
      },
    }, 'r1')
    expect(result).not.toBeNull()
    const picked = result!.element!
    expect(picked.tagName).toBe('div')
    expect(picked.pageTitle).toBe('')
    expect(picked.text).toBeUndefined()
    expect(picked.attributes).toEqual({ id: 'a' })
    expect(picked.rect).toEqual({ x: 0, y: 4, width: 10, height: 20 })
    expect(picked.style).toEqual({ color: '#FFF' })
    expect(typeof picked.capturedAt).toBe('number')
  })
})

describe('web element insert block (ZCode-identical serialization)', () => {
  it('renders the section heading, identity rows, style rows and fenced sections', () => {
    const insert = buildWebElementInsert(element())
    expect(insert.split('\n')).toEqual([
      '# Web page elements:',
      '',
      '## Element 1',
      'URL: https://example.com/pricing?plan=pro',
      'Title: Pricing',
      'Tag: button',
      'Role: button',
      'Accessible name: Start trial',
      'Selector: #app > form.signup > button.primary',
      'XPath: /html/body/div[1]/form[1]/button[1]',
      'Attributes: class="primary" type="submit"',
      'Color: #FFFFFF',
      'Background: #2563EB',
      'Font: 14px Inter, sans-serif',
      'Font weight: 600',
      'Display: inline-flex',
      'Rect: x=12, y=341, width=88, height=32',
      '',
      'Text:',
      '```',
      'Start trial',
      '```',
      '',
      'Nearby context:',
      '```',
      'Pro plan  $20/mo  Start trial',
      '```',
      '',
      'HTML excerpt:',
      '```html',
      '<button class="primary">Start trial</button>',
      '```',
    ])
  })

  it('omits absent rows and marks an untitled page', () => {
    const insert = buildWebElementInsert({
      pageUrl: 'https://example.com/',
      pageTitle: '',
      tagName: 'div',
      selector: 'div',
      attributes: {},
      rect: { x: 0, y: 0, width: 0, height: 0 },
      style: {},
      capturedAt: 0,
    })
    expect(insert).toContain('Title: (untitled)')
    expect(insert).not.toContain('Role:')
    expect(insert).not.toContain('Attributes:')
    expect(insert).not.toContain('Background:')
    expect(insert).not.toContain('Text:')
    expect(insert).toContain('Rect: x=0, y=0, width=0, height=0')
  })

  it('truncates an over-long section', () => {
    const insert = buildWebElementInsert(element({ text: 'x'.repeat(9000) }))
    expect(insert).toContain('[truncated]')
    expect(insert.length).toBeLessThan(20000)
  })

  it('continues the numbering of the draft it is appended to', () => {
    const first = buildWebElementInsert(element())
    expect(first.startsWith('# Web page elements:\n\n## Element 1\n')).toBe(true)
    // A draft that already carries the section: only the next block is added,
    // exactly like ZCode re-serializing two attachments.
    const draft = 'have a look\n\n' + first
    const second = buildWebElementInsert(element({ tagName: 'a' }), draft)
    expect(second.startsWith('## Element 2\n')).toBe(true)
    expect(second).not.toContain('# Web page elements:')
    const third = buildWebElementInsert(element({ tagName: 'p' }), draft + '\n\n' + second)
    expect(third.startsWith('## Element 3\n')).toBe(true)
  })

  it('counts only the blocks of the trailing elements section', () => {
    expect(countWebElementBlocks('')).toBe(0)
    expect(countWebElementBlocks('## Element 1\nnot a section')).toBe(0)
    expect(countWebElementBlocks('# Web page elements:\n\n## Element 1\nURL: x')).toBe(1)
  })

  it('restarts the numbering for a draft without the section', () => {
    expect(buildWebElementInsert(element(), 'just some text').startsWith('# Web page elements:')).toBe(true)
  })
})

describe('bridge injection into served HTML', () => {
  it('is valid standalone JavaScript', () => {
    // Parse-only check: the payload is serialized function source, so a
    // refactor that breaks its self-containment must fail here.
    expect(() => new Function(pickerBridgeSource())).not.toThrow()
    expect(pickerBridgeSource()).toContain(PICKER_CHANNEL)
  })

  it('injects one script right after <head>', () => {
    const injected = injectPickerBridge('<!doctype html><html><head><title>t</title></head><body>hi</body></html>')
    expect(injected).toContain('<head><script ' + PICKER_BRIDGE_MARKER + '>')
    expect(injected.indexOf(PICKER_BRIDGE_MARKER)).toBeLessThan(injected.indexOf('<title>'))
    expect(injected.endsWith('<body>hi</body></html>')).toBe(true)
  })

  it('falls back to the <html> tag, then to the document start', () => {
    expect(injectPickerBridge('<html><body>hi</body></html>')).toContain('<html><script ')
    expect(injectPickerBridge('<p>fragment</p>').endsWith('<p>fragment</p>')).toBe(true)
  })

  it('never injects twice', () => {
    const once = injectPickerBridge('<html><head></head></html>')
    expect(injectPickerBridge(once)).toBe(once)
  })

  it('closes no script tag early', () => {
    expect(pickerBridgeSource().toLowerCase()).not.toContain('</script')
  })
})

describe('parent-side picker controller', () => {
  it('starts dormant and refuses to pick before the ready handshake', () => {
    const { controller, frame, states } = harness()
    expect(controller.state()).toEqual({ ready: false, picking: false, notice: null })
    controller.start()
    expect(frame.posted).toEqual([])
    expect(controller.state()).toEqual({ ready: false, picking: false, notice: 'unsupported' })
    expect(states.at(-1)?.notice).toBe('unsupported')
  })

  it('becomes ready on the bridge announcement and posts one start request', () => {
    const { controller, frame } = harness({ ready: true })
    expect(controller.state().ready).toBe(true)
    controller.start()
    expect(frame.posted).toEqual([startMessage('req-1', PICKER_DEFAULTS)])
    expect(controller.state()).toMatchObject({ picking: true, notice: 'hint' })
  })

  it('hands a selected element over and clears the session', () => {
    const { controller, frame, picked } = harness({ ready: true })
    controller.start()
    controller.handleMessage({
      source: frame.target,
      data: { channel: PICKER_CHANNEL, type: 'result', requestId: 'req-1', status: 'selected', element: element() },
    })
    expect(picked).toHaveLength(1)
    expect(picked[0]?.selector).toBe('#app > form.signup > button.primary')
    expect(controller.state()).toEqual({ ready: true, picking: false, notice: null })
  })

  it('ignores a cancelled result, a stale request and a foreign source', () => {
    const { controller, frame, picked } = harness({ ready: true })
    controller.start()
    controller.handleMessage({
      source: { postMessage: () => {} },
      data: { channel: PICKER_CHANNEL, type: 'result', requestId: 'req-1', status: 'selected', element: element() },
    })
    expect(picked).toHaveLength(0)
    expect(controller.state().picking).toBe(true)
    controller.handleMessage({
      source: frame.target,
      data: { channel: PICKER_CHANNEL, type: 'result', requestId: 'stale', status: 'selected', element: element() },
    })
    expect(picked).toHaveLength(0)
    controller.handleMessage({
      source: frame.target,
      data: { channel: PICKER_CHANNEL, type: 'result', requestId: 'req-1', status: 'cancelled' },
    })
    expect(picked).toHaveLength(0)
    expect(controller.state().picking).toBe(false)
  })

  it('toggles: the second press cancels the live request in the frame', () => {
    const { controller, frame } = harness({ ready: true })
    controller.toggle()
    controller.toggle()
    expect(frame.posted).toEqual([startMessage('req-1', PICKER_DEFAULTS), cancelMessage('req-1')])
    expect(controller.state().picking).toBe(false)
  })

  it('a late answer to a cancelled request never inserts an element', () => {
    const { controller, frame, picked } = harness({ ready: true })
    controller.start()
    controller.cancel()
    controller.handleMessage({
      source: frame.target,
      data: { channel: PICKER_CHANNEL, type: 'result', requestId: 'req-1', status: 'selected', element: element() },
    })
    expect(picked).toHaveLength(0)
  })

  it('a frame load drops the handshake, aborts the session and re-probes', () => {
    const { controller, frame } = harness({ ready: true })
    controller.start()
    frame.posted.length = 0
    controller.handleFrameLoad()
    expect(controller.state()).toEqual({ ready: false, picking: false, notice: null })
    // The blanket cancel puts a document that survived the reset back to rest.
    expect(frame.posted).toEqual([cancelMessage(), pingMessage()])
    // The reloaded document must re-announce itself before picking again.
    controller.start()
    expect(controller.state().notice).toBe('unsupported')
  })

  it('an unmounted frame cannot be picked (no crash, no post)', () => {
    const { controller, detach, frame } = harness({ ready: true })
    detach()
    controller.start()
    expect(frame.posted).toEqual([])
    expect(controller.state().notice).toBe('unsupported')
  })
})

describe('arming a session for the document about to load', () => {
  const readyFrom = (frame: { target: PickerTarget }) => ({
    source: frame.target,
    data: { channel: PICKER_CHANNEL, type: 'ready' },
  })

  it('ignores the announcement that precedes the frame load, and starts on the one after it', () => {
    const { controller, frame } = harness()
    controller.armForNextDocument()
    // The injected bridge announces itself while its document is still parsing.
    // Starting here is the bug: the load event that follows resets the handshake
    // and orphans the session (the page stays overlaid, the capture is dropped).
    controller.handleMessage(readyFrom(frame))
    expect(controller.state()).toMatchObject({ ready: true, picking: false })
    expect(frame.posted).toEqual([])

    controller.handleFrameLoad()
    expect(controller.state()).toMatchObject({ ready: false, picking: false })
    expect(frame.posted).toEqual([cancelMessage(), pingMessage()])

    controller.handleMessage(readyFrom(frame))
    expect(controller.state()).toMatchObject({ ready: true, picking: true, notice: 'hint' })
    expect(frame.posted.at(-1)).toEqual(startMessage('req-1', PICKER_DEFAULTS))
  })

  it('always waits for a load, even when the document on screen is ready', () => {
    const { controller, frame } = harness()
    controller.handleFrameLoad()
    controller.armForNextDocument()
    // The document on screen is the one being replaced, so its bridge must not
    // answer for the incoming one.
    controller.handleMessage(readyFrom(frame))
    expect(controller.state().picking).toBe(false)
    controller.handleFrameLoad()
    controller.handleMessage(readyFrom(frame))
    expect(controller.state().picking).toBe(true)
  })

  it('arms exactly one session (a later load does not restart it)', () => {
    const { controller, frame } = harness()
    controller.armForNextDocument()
    controller.handleFrameLoad()
    controller.handleMessage(readyFrom(frame))
    expect(controller.state().picking).toBe(true)
    controller.handleFrameLoad()
    controller.handleMessage(readyFrom(frame))
    expect(controller.state().picking).toBe(false)
  })

  it('disarms on cancel (leaving proxy mode must not fire a pending session)', () => {
    const { controller, frame } = harness()
    controller.armForNextDocument()
    controller.cancel()
    controller.handleFrameLoad()
    controller.handleMessage(readyFrom(frame))
    expect(controller.state().picking).toBe(false)
  })

  it('cancels whatever the frame is still running when a document loads', () => {
    const { controller, frame } = harness({ ready: true })
    controller.start()
    expect(frame.posted).toEqual([startMessage('req-1', PICKER_DEFAULTS)])
    controller.handleFrameLoad()
    // The blanket cancel (no request id) covers the frame whose session id this
    // reset just dropped; the ping re-opens the handshake.
    expect(frame.posted.slice(1)).toEqual([cancelMessage(), pingMessage()])
    expect(controller.state()).toEqual({ ready: false, picking: false, notice: null })
  })

  it('reports the end of a session so the surface can take focus back', () => {
    const { controller, frame, sessionEnds } = harness({ ready: true })
    controller.start()
    expect(sessionEnds).toEqual([])
    controller.handleMessage({
      source: frame.target,
      data: { channel: PICKER_CHANNEL, type: 'result', requestId: 'req-1', status: 'cancelled' },
    })
    expect(sessionEnds).toHaveLength(1)
    controller.start()
    controller.cancel()
    expect(sessionEnds).toHaveLength(2)
  })
})
