/**
 * The PARENT half of the web-element picker: the controller that talks to the
 * bridge injected into the framed document (see src/element-picker.ts for the
 * protocol and src/element-picker-bridge.ts for the in-frame half), plus the
 * React hook the two web surfaces use.
 *
 * The controller is framework-free (a plain state machine over postMessage) so
 * the unit tests drive it with fake frames; the hook only wires it to React
 * state, the window `message` listener, the parent-side Esc key and the
 * unmount cancel.
 *
 * Handshake: a fresh document is assumed picker-LESS until its bridge answers
 * the ping posted after every frame load. A remote site in the browser tab
 * never answers (no bridge can be injected into a cross-origin document), so
 * `ready` stays false and the surfaces keep their toggle disabled instead
 * of hanging on a request nobody will answer.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PICKER_DEFAULTS,
  cancelMessage,
  isReadyMessage,
  pingMessage,
  readResultMessage,
  startMessage,
} from '../element-picker.ts'
import { TOKEN_ROUTE_PATH } from '../browser-proxy.ts'
import type { PickedElement, PickerConfig, PickerLabels } from '../element-picker.ts'
import { t } from './locales.ts'

/** The minimal frame-window face the controller needs (an iframe's contentWindow). */
export interface PickerTarget {
  postMessage(message: unknown, targetOrigin: string): void
}

/** The controller's observable state (mirrored into React state by the hook). */
export interface ElementPickerState {
  /** Whether the framed document answered the ready handshake. */
  ready: boolean
  /** Whether a picking session is running right now. */
  picking: boolean
  /** The hint shown while picking, or the failure copy (null = nothing to show). */
  notice: string | null
}

/** Everything the controller needs from its surface. */
export interface ElementPickerHost {
  /** The framed document's window, or null before it is mounted/loaded. */
  target: () => PickerTarget | null
  /** The localized capture config (read per request so a locale switch applies). */
  config: () => PickerConfig
  /** The localized copy (read per use, same reason). */
  copy: () => { hint: string; unsupported: string }
  /** Called on every state transition. */
  onState: (state: ElementPickerState) => void
  /** Called once per captured element. */
  onPicked: (element: PickedElement) => void
  /**
   * Called when a session ends (a capture, a cancel from either side). The
   * surface uses it to take keyboard focus back from the frame: while the frame
   * holds focus, the parent's Esc handler never sees a key, so the sidebar could
   * not leave proxy mode after the in-frame Esc cancelled a capture.
   */
  onSessionEnd?: () => void
  /** Request-id factory (injectable so tests stay deterministic). */
  newRequestId?: () => string
}

/** The parent-side picker state machine. */
export interface ElementPickerController {
  /** Feed one window message event (foreign messages are ignored). */
  handleMessage: (event: { source: unknown; data: unknown }) => void
  /** The frame finished loading a document: re-probe its bridge. */
  handleFrameLoad: () => void
  start: () => void
  /**
   * Arm a session for the document that is ABOUT to load, instead of the one on
   * screen: the session begins at the first ready handshake that FOLLOWS the next
   * frame load. This is what a surface uses when pressing the crosshair also
   * swaps the frame's src (proxied picking).
   *
   * Why the wait: the injected bridge announces itself while the document is
   * still parsing, so a start driven by that announcement lands before the load
   * event — and the load event then resets the handshake and orphans the session
   * (the bridge overlays the page, the parent has forgotten the request id, and
   * the captured element is dropped).
   */
  armForNextDocument: () => void
  cancel: () => void
  /** Start, or cancel when a session is already running. */
  toggle: () => void
  state: () => ElementPickerState
}

/** A random-enough request id (crypto when available). */
function defaultRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'pick-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * Create one picker controller for a surface. The controller owns the request
 * lifecycle: only the newest request id is honored, so a stale answer (a
 * cancelled session, a reloaded document) can never insert an element.
 */
export function createElementPickerController(host: ElementPickerHost): ElementPickerController {
  let ready = false
  let picking = false
  let notice: string | null = null
  /** The id of the live request (null while dormant). */
  let requestId: string | null = null
  /** A session armed by {@link ElementPickerController.armForNextDocument}. */
  let armed = false
  /** Whether the frame has loaded a document since the session was armed. */
  let loadSeen = false
  const newRequestId = host.newRequestId ?? defaultRequestId

  const publish = (): void => { host.onState({ ready, picking, notice }) }

  const cancel = (): void => {
    const pending = requestId
    requestId = null
    picking = false
    notice = null
    // Cancelling also disarms: a surface that leaves proxy mode (or the Esc that
    // does it) must not leave a session waiting to fire on the next document.
    armed = false
    if (pending !== null) {
      host.target()?.postMessage(cancelMessage(pending), '*')
      host.onSessionEnd?.()
    }
    publish()
  }

  const start = (): void => {
    const target = host.target()
    if (target === null || !ready) {
      // No bridge in this document (a cross-origin site, or a frame that has
      // not loaded yet): say so instead of starting a request nobody answers.
      requestId = null
      picking = false
      notice = host.copy().unsupported
      publish()
      return
    }
    const id = newRequestId()
    requestId = id
    picking = true
    notice = host.copy().hint
    publish()
    target.postMessage(startMessage(id, host.config()), '*')
  }

  return {
    handleMessage: (event) => {
      const target = host.target()
      if (target === null || event.source !== target) return
      if (isReadyMessage(event.data)) {
        if (!ready) {
          ready = true
          publish()
        }
        // An armed session waits for the document that answered AFTER a load:
        // the announcement of a still-parsing document would be orphaned by the
        // load event that follows it.
        if (armed && loadSeen) {
          armed = false
          start()
        }
        return
      }
      if (requestId === null) return
      const result = readResultMessage(event.data, requestId)
      if (result === null) return
      requestId = null
      picking = false
      notice = null
      publish()
      host.onSessionEnd?.()
      if (result.status === 'selected' && result.element !== undefined) host.onPicked(result.element)
    },
    handleFrameLoad: () => {
      // A new document carries a new (or no) bridge: drop the handshake and any
      // live request, then probe. The bridge also announces itself on install;
      // the ping covers the load that beat this listener.
      ready = false
      requestId = null
      picking = false
      notice = null
      loadSeen = true
      publish()
      // Cancel with no request id: if this document is the SAME one the parent
      // was just talking to (a load event that arrived after the bridge's
      // announcement), it may still be overlaying the page under a request id
      // this reset just dropped. A blanket cancel puts it back to rest; a fresh
      // document has no session and ignores it.
      host.target()?.postMessage(cancelMessage(), '*')
      host.target()?.postMessage(pingMessage(), '*')
    },
    start,
    armForNextDocument: () => {
      armed = true
      // The document on screen is about to be replaced: only a load AFTER this
      // call may satisfy the arming.
      loadSeen = false
    },
    cancel,
    toggle: () => {
      if (picking) cancel()
      else start()
    },
    state: () => ({ ready, picking, notice }),
  }
}

/** The localized in-frame popover labels. */
export function pickerLabels(): PickerLabels {
  return {
    color: t('pickerLabelColor'),
    background: t('pickerLabelBackground'),
    font: t('pickerLabelFont'),
  }
}

/**
 * The localized capture config (budgets stay at the shared defaults).
 * @param pageUrl - the real page URL when the framed document is proxied
 *                  (src/browser-proxy.ts), so the capture names the site
 *                  instead of the /sidebar/proxy route.
 */
export function pickerConfig(pageUrl?: string): PickerConfig {
  return {
    ...PICKER_DEFAULTS,
    labels: pickerLabels(),
    ...(pageUrl !== undefined && pageUrl !== '' ? { pageUrl } : {}),
  }
}

/** What the hook hands back to a surface. */
export interface ElementPicker extends ElementPickerState {
  /** Toggle picking (the toolbar button's onClick). */
  toggle: () => void
  /**
   * Arm a session for the document the frame is about to load (see
   * {@link ElementPickerController.armForNextDocument}): the crosshair that also
   * swaps the frame's src uses this instead of {@link ElementPicker.toggle}.
   */
  armForNextDocument: () => void
  cancel: () => void
  /** The iframe's onLoad handler (drives the ready handshake). */
  handleLoad: () => void
}

/**
 * Wire one picker controller into a React surface: mirrors its state, feeds it
 * window messages, cancels on Esc (the parent copy of the in-frame handler —
 * the frame only sees Esc while IT has focus) and on unmount.
 * @param frame - reads the current iframe element (a ref getter).
 * @param onPicked - receives every captured element.
 */
export function useElementPicker(opts: {
  frame: () => { contentWindow: PickerTarget | null } | null
  onPicked: (element: PickedElement) => void
  /** The real page URL when the frame shows a proxied document (optional). */
  pageUrl?: () => string | undefined
}): ElementPicker {
  const [state, setState] = useState<ElementPickerState>({ ready: false, picking: false, notice: null })
  const optsRef = useRef(opts)
  optsRef.current = opts
  const controllerRef = useRef<ElementPickerController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createElementPickerController({
      target: () => optsRef.current.frame()?.contentWindow ?? null,
      config: () => pickerConfig(optsRef.current.pageUrl?.()),
      copy: () => ({ hint: t('pickElementHint'), unsupported: t('pickElementUnsupported') }),
      onState: setState,
      onSessionEnd: () => {
        // Take focus back from the frame. While a nested document holds it, the
        // parent's Esc handler never fires, so the surface could not act on a
        // second Esc (leaving proxy mode) after the in-frame one cancelled.
        try {
          const frame = optsRef.current.frame() as unknown as (Element & { blur?: () => void }) | null
          if (typeof document !== 'undefined' && frame !== null && document.activeElement === frame) {
            frame.blur?.()
          }
        } catch {
          // A frame that refuses to blur changes nothing else.
        }
      },
      onPicked: element => { optsRef.current.onPicked(element) },
    })
  }
  const controller = controllerRef.current

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onMessage = (event: MessageEvent): void => { controller.handleMessage(event) }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [controller])

  useEffect(() => {
    if (!state.picking || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      controller.cancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [controller, state.picking])

  useEffect(() => () => { controller.cancel() }, [controller])

  const toggle = useCallback(() => { controller.toggle() }, [controller])
  const armForNextDocument = useCallback(() => { controller.armForNextDocument() }, [controller])
  const cancel = useCallback(() => { controller.cancel() }, [controller])
  const handleLoad = useCallback(() => { controller.handleFrameLoad() }, [controller])
  return { ...state, toggle, armForNextDocument, cancel, handleLoad }
}

/**
 * Mint one capability token for the proxy route.
 *
 * The proxied page loads into a SANDBOXED frame, so the browser labels that
 * navigation `Origin: null` / `Sec-Fetch-Site: cross-site` — markers the route's
 * fence must keep refusing. This same-origin call is how the GUI (and only the
 * GUI) re-authorizes that one navigation.
 *
 * @returns the token to pass to {@link encodeProxyUrl}.
 * @throws when the route refuses or answers without a token.
 */
export async function fetchProxyToken(): Promise<string> {
  const response = await fetch(TOKEN_ROUTE_PATH, { method: 'GET', credentials: 'same-origin' })
  if (!response.ok) throw new Error('proxy token route refused: ' + String(response.status))
  const body = await response.json() as { token?: unknown }
  const token = typeof body.token === 'string' ? body.token : ''
  if (token === '') throw new Error('proxy token route answered without a token')
  return token
}
