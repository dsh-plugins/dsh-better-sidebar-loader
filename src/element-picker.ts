/**
 * The web-element picker contract: the postMessage protocol between the GUI
 * (parent) and the picker bridge injected into the documents this plugin
 * SERVES, plus the model-facing text one picked element turns into.
 *
 * Why a message protocol instead of touching the frame's DOM: every web
 * surface of this sidebar renders in a SANDBOXED iframe without
 * `allow-same-origin` (and /sidebar/html additionally answers with the CSP
 * `sandbox` directive), so the previewed document always sits in an opaque
 * origin — the parent can never read `contentDocument`, and an arbitrary
 * cross-origin site can never be scripted at all. The picker therefore runs
 * INSIDE the document, and only documents this plugin serves carry it (the
 * /sidebar/html preview route injects the bridge; see element-picker-bridge.ts).
 * A remote site in the browser tab has no bridge, never answers the ready
 * handshake, and the toolbar action stays disabled — the documented limit of
 * this feature.
 *
 * Kept dependency-free (no node imports, no React) so BOTH halves import it:
 * the host route builder and the client controller, with the unit tests
 * driving the pure builders/validators directly.
 */

/** The postMessage channel every picker message carries (parent + bridge). */
export const PICKER_CHANNEL = 'dsh-better-sidebar:element-picker'

/** Localized labels rendered by the in-frame info popover. */
export interface PickerLabels {
  /** Computed text color row. */
  color: string
  /** Computed background color row. */
  background: string
  /** Computed font (size + family) row. */
  font: string
}

/** Capture budget + labels handed to the bridge with every start request. */
export interface PickerConfig {
  /** Max characters of the element text / nearby text (truncated with an ellipsis). */
  maxTextChars: number
  /** Max characters of the sanitized outerHTML excerpt. */
  maxHtmlChars: number
  /** Max characters of one captured attribute value. */
  maxAttributeChars: number
  labels: PickerLabels
  /**
   * The URL to report as the element's page. Set when the framed document is
   * NOT the page the user thinks they are on — the element-picker proxy
   * (src/browser-proxy.ts) serves a remote page from a /sidebar/proxy URL, and
   * the capture must name the real site, not the route. Omitted = the
   * document's own `location.href`.
   */
  pageUrl?: string
}

/** Capture budget defaults (the labels are English; the client passes localized ones). */
export const PICKER_DEFAULTS: PickerConfig = {
  maxTextChars: 4000,
  maxHtmlChars: 6000,
  maxAttributeChars: 500,
  labels: { color: 'Color', background: 'Background', font: 'Font' },
}

/** The computed style rows captured with one element (colors normalized to #RRGGBB). */
export interface PickedElementStyle {
  color?: string
  /** Absent when the element paints no background (fully transparent). */
  backgroundColor?: string
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  display?: string
}

/** The element's viewport rectangle (CSS pixels). */
export interface PickedElementRect {
  x: number
  y: number
  width: number
  height: number
}

/** One picked element: everything the model needs to locate and judge it. */
export interface PickedElement {
  pageUrl: string
  pageTitle: string
  tagName: string
  /** Explicit `role` attribute, else the inferred ARIA role. */
  role?: string
  /** aria-label / aria-labelledby / alt / title / placeholder / text. */
  accessibleName?: string
  /** A CSS path (id-anchored when possible) that re-selects the element. */
  selector: string
  /** Positional XPath fallback for elements with no stable classes/ids. */
  xpath?: string
  text?: string
  /** Text of the nearest article/section/form/list-item container. */
  nearbyText?: string
  /** Sanitized outerHTML (scripts/styles dropped, input values stripped). */
  htmlExcerpt?: string
  /** Whitelisted attributes (id/class/href/src/alt/title/name/type/placeholder/aria-*). */
  attributes: Record<string, string>
  rect: PickedElementRect
  style: PickedElementStyle
  capturedAt: number
}

/** Bridge → parent: the bridge is installed and can pick in this document. */
export interface PickerReadyMessage {
  channel: typeof PICKER_CHANNEL
  type: 'ready'
}

/** Parent → bridge: "are you there?" (answered with {@link PickerReadyMessage}). */
export interface PickerPingMessage {
  channel: typeof PICKER_CHANNEL
  type: 'ping'
}

/** Parent → bridge: begin picking for one request id. */
export interface PickerStartMessage {
  channel: typeof PICKER_CHANNEL
  type: 'start'
  requestId: string
  config: PickerConfig
}

/** Parent → bridge: abort the request (the toolbar toggle, Esc, unmount). */
export interface PickerCancelMessage {
  channel: typeof PICKER_CHANNEL
  type: 'cancel'
  /**
   * The session to abort. Omitted to abort WHATEVER the bridge is running: the
   * parent uses that after a frame load, when a document that survived a reset
   * may still hold a session whose id the parent no longer knows.
   */
  requestId?: string
}

/** Bridge → parent: the outcome of one request. */
export interface PickerResultMessage {
  channel: typeof PICKER_CHANNEL
  type: 'result'
  requestId: string
  status: 'selected' | 'cancelled'
  /** Present exactly when `status === 'selected'`. */
  element?: PickedElement
}

/** Any message flowing on {@link PICKER_CHANNEL}. */
export type PickerMessage =
  | PickerReadyMessage
  | PickerPingMessage
  | PickerStartMessage
  | PickerCancelMessage
  | PickerResultMessage

/** The ping the parent posts after every frame load (handshake probe). */
export function pingMessage(): PickerPingMessage {
  return { channel: PICKER_CHANNEL, type: 'ping' }
}

/** The start request for one picking session. */
export function startMessage(requestId: string, config: PickerConfig = PICKER_DEFAULTS): PickerStartMessage {
  return { channel: PICKER_CHANNEL, type: 'start', requestId, config }
}

/**
 * The cancel request. Without a request id it aborts any session the bridge is
 * running (see {@link PickerCancelMessage.requestId}).
 */
export function cancelMessage(requestId?: string): PickerCancelMessage {
  return requestId === undefined
    ? { channel: PICKER_CHANNEL, type: 'cancel' }
    : { channel: PICKER_CHANNEL, type: 'cancel', requestId }
}

/** Whether `data` is the bridge's ready announcement. */
export function isReadyMessage(data: unknown): data is PickerReadyMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as Record<string, unknown>
  return message.channel === PICKER_CHANNEL && message.type === 'ready'
}

/** A non-empty string, or undefined for anything else (defensive read). */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite number, or 0 (rects arrive from the frame and are only informative). */
function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Validate the untrusted `element` payload of a result message. */
function readElement(value: unknown): PickedElement | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const pageUrl = optionalString(raw.pageUrl)
  const tagName = optionalString(raw.tagName)
  const selector = optionalString(raw.selector)
  if (pageUrl === undefined || tagName === undefined || selector === undefined) return null
  const attributes: Record<string, string> = {}
  if (typeof raw.attributes === 'object' && raw.attributes !== null) {
    for (const [name, attributeValue] of Object.entries(raw.attributes as Record<string, unknown>)) {
      if (typeof attributeValue === 'string') attributes[name] = attributeValue
    }
  }
  const rectRaw = (typeof raw.rect === 'object' && raw.rect !== null ? raw.rect : {}) as Record<string, unknown>
  const styleRaw = (typeof raw.style === 'object' && raw.style !== null ? raw.style : {}) as Record<string, unknown>
  const style: PickedElementStyle = {}
  for (const key of ['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'display'] as const) {
    const styleValue = optionalString(styleRaw[key])
    if (styleValue !== undefined) style[key] = styleValue
  }
  const element: PickedElement = {
    pageUrl,
    pageTitle: typeof raw.pageTitle === 'string' ? raw.pageTitle : '',
    tagName: tagName.toLowerCase(),
    selector,
    attributes,
    rect: {
      x: finiteNumber(rectRaw.x),
      y: finiteNumber(rectRaw.y),
      width: finiteNumber(rectRaw.width),
      height: finiteNumber(rectRaw.height),
    },
    style,
    capturedAt: typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt) ? raw.capturedAt : Date.now(),
  }
  for (const key of ['role', 'accessibleName', 'xpath', 'text', 'nearbyText', 'htmlExcerpt'] as const) {
    const optional = optionalString(raw[key])
    if (optional !== undefined) element[key] = optional
  }
  return element
}

/**
 * Validate one incoming message as the result of `requestId`. Returns null
 * for anything else — a foreign message, another (stale) request, or a
 * malformed payload — so the caller can ignore it without branching.
 */
export function readResultMessage(data: unknown, requestId: string): PickerResultMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (message.channel !== PICKER_CHANNEL || message.type !== 'result') return null
  if (message.requestId !== requestId) return null
  if (message.status === 'cancelled') {
    return { channel: PICKER_CHANNEL, type: 'result', requestId, status: 'cancelled' }
  }
  if (message.status !== 'selected') return null
  const element = readElement(message.element)
  if (element === null) return null
  return { channel: PICKER_CHANNEL, type: 'result', requestId, status: 'selected', element }
}

/**
 * The section heading ZCode's composer writes above its picked elements, and
 * the per-element block heading under it. Kept byte-identical to ZCode's own
 * serializer (`# Web page elements:` + `## Element N`) so the text a model
 * receives from this sidebar is the text it receives from ZCode.
 */
export const WEB_ELEMENTS_HEADING = '# Web page elements:'
/** The per-element heading; ZCode numbers it `## Element N` (1-based). */
export const WEB_ELEMENT_BLOCK_HEADING = '## Element'
/** ZCode's own reader regex for the trailing elements section. */
const ELEMENTS_SECTION = /(?:^|\n\n)# Web page elements:\s*\n\n([\s\S]*?)\s*$/
/** ZCode's own block splitter (numbered or bare heading). */
const BLOCK_HEADING = /^## Element(?:\s+\d+)?$/gm

/** Max characters of one text/HTML section inside the inserted block. */
export const WEB_ELEMENT_SECTION_LIMIT = 8000

/** The markdown fence of the text/HTML sections (kept as a constant so the
 *  block builder needs no backtick escaping). */
const FENCE = '\u0060\u0060\u0060'

/** Trim + truncate one section body (an over-long body is marked truncated). */
function section(value: string | undefined): string {
  if (value === undefined) return ''
  const text = value.trim()
  if (text === '') return ''
  return text.length > WEB_ELEMENT_SECTION_LIMIT
    ? `${text.slice(0, WEB_ELEMENT_SECTION_LIMIT)}\n\n[truncated]`
    : text
}

/** Push `Label: value` when the value survives {@link section}. */
function pushRow(rows: string[], label: string, value: string | undefined): void {
  const text = section(value)
  if (text !== '') rows.push(`${label}: ${text}`)
}

/** `k="v" k2="v2"` — the captured attributes on one line. */
function attributeRow(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes)
  if (entries.length === 0) return ''
  return entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(' ')
}

/** `14px Inter, sans-serif` — the font row of the computed style. */
function fontRow(style: PickedElementStyle): string {
  return [style.fontSize, style.fontFamily].filter(part => part !== undefined && part !== '').join(' ')
}

/**
 * One element's block, exactly as ZCode serializes it: `## Element N` plus the
 * identity rows, the computed-style rows, the rect row and the fenced
 * text/nearby/HTML sections (8000 chars each, marked when truncated).
 * @param element - the captured element.
 * @param index - the 1-based number ZCode writes into the heading.
 */
export function buildWebElementBlock(element: PickedElement, index: number): string {
  const rows: string[] = [
    `${WEB_ELEMENT_BLOCK_HEADING} ${index}`,
    `URL: ${element.pageUrl}`,
    `Title: ${element.pageTitle === '' ? '(untitled)' : element.pageTitle}`,
    `Tag: ${element.tagName.toLowerCase()}`,
  ]
  pushRow(rows, 'Role', element.role)
  pushRow(rows, 'Accessible name', element.accessibleName)
  pushRow(rows, 'Selector', element.selector)
  pushRow(rows, 'XPath', element.xpath)
  pushRow(rows, 'Attributes', attributeRow(element.attributes))
  pushRow(rows, 'Color', element.style.color)
  pushRow(rows, 'Background', element.style.backgroundColor)
  pushRow(rows, 'Font', fontRow(element.style))
  pushRow(rows, 'Font weight', element.style.fontWeight)
  pushRow(rows, 'Display', element.style.display)
  rows.push(`Rect: x=${Math.round(element.rect.x)}, y=${Math.round(element.rect.y)}, width=${Math.round(element.rect.width)}, height=${Math.round(element.rect.height)}`)
  const text = section(element.text)
  if (text !== '') rows.push('', 'Text:', FENCE, text, FENCE)
  const nearby = section(element.nearbyText)
  if (nearby !== '') rows.push('', 'Nearby context:', FENCE, nearby, FENCE)
  const html = section(element.htmlExcerpt)
  if (html !== '') rows.push('', 'HTML excerpt:', `${FENCE}html`, html, FENCE)
  return rows.join('\n')
}

/**
 * How many element blocks the draft's trailing elements section already holds.
 * @param draft - the current composer draft ('' when empty).
 */
export function countWebElementBlocks(draft: string): number {
  const section = ELEMENTS_SECTION.exec(draft)
  if (section === null || section[1] === undefined) return 0
  return (section[1].match(BLOCK_HEADING) ?? []).length
}

/**
 * The text to append to the composer draft for one picked element.
 *
 * ZCode keeps picked elements as removable attachments and re-serializes them
 * all at send time; this sidebar appends plain text to the DSH composer draft
 * (the same path as the viewer selection popup). To keep the RESULT identical,
 * the first insert writes the `# Web page elements:` section heading and
 * `## Element 1`, and every later insert continues the numbering of the
 * section already in the draft — so a draft with three picks is byte-for-byte
 * what ZCode would have sent.
 * @param element - the captured element.
 * @param draft - the current composer draft (used only for the numbering).
 */
export function buildWebElementInsert(element: PickedElement, draft = ''): string {
  const existing = countWebElementBlocks(draft)
  const block = buildWebElementBlock(element, existing + 1)
  return existing === 0 ? `${WEB_ELEMENTS_HEADING}\n\n${block}` : block
}
