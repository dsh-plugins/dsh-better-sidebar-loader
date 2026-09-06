/**
 * The built-in browser tab: an address bar plus a sandboxed iframe.
 *
 * Security model (see browser.ts + the sandbox tokens below): the iframe is
 * ALWAYS sandboxed without `allow-same-origin` (opaque origin — the visited
 * page can never sit on the GUI's origin, read its storage, or reach
 * /sidebar/api) and without `allow-top-navigation` (a page must not hijack
 * the GUI). The address bar only accepts http(s) and refuses loopback /
 * the GUI's own origin. The side card setting "关闭浏览器沙箱" drops the
 * sandbox attribute entirely for fully trusted sites — the visited page then
 * runs with the GUI's own origin and full session access, so a persistent
 * warning bar renders while it is off.
 *
 * The URL is persisted onto the tab (path/title via the patchTab reducer)
 * so a reload restores the visited page; the back/forward stack only tracks
 * address-bar navigations (in-frame link clicks are cross-origin and
 * invisible — a documented limitation).
 *
 * Element picker ("选择网页元素加入聊天"): the toolbar's crosshair toggle. For a
 * document THIS plugin serves, the injected bridge answers directly; for a
 * remote site the crosshair re-serves the page through /sidebar/proxy first (a
 * cross-origin frame cannot be scripted at all).
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconLinkOutline14,
  IconRefreshOutline14,
  IconRightUpOutline16,
  IconWarningOutline16,
} from '@dsh-plugin/dsh-loader/ui-primitives'
import { api } from './api.ts'
import { embeddabilityOf, normalizeBrowserUrl } from './browser.ts'
import { appendToDraft, readDraft } from './conversation-draft.ts'
import { fetchProxyToken, useElementPicker } from './element-picker.ts'
import { buildWebElementInsert } from '../element-picker.ts'
import { encodeProxyUrl, isProxyablePage } from '../browser-proxy.ts'
import { IconCrosshairOutline16 } from './icons.tsx'
import { patchTab } from './state.ts'
import { SandboxStatusBar } from './SandboxStatusBar.tsx'
import { t } from './locales.ts'
import type { TabComponentProps } from './service.ts'
import css from './sidebar.module.css'

/**
 * The browser iframe sandbox tokens. NO allow-same-origin (opaque origin —
 * no GUI storage/API access), NO allow-top-navigation (a browsed page must
 * not hijack the GUI). allow-forms/allow-popups/allow-downloads/allow-modals
 * keep login flows working; allow-popups-to-escape-sandbox lets OAuth
 * popups open as normal tabs (they are cross-origin to the GUI either way).
 */
export const BROWSER_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'

/** The browser tab. */
export function BrowserView(props: TabComponentProps) {
  const { store, tab, ctx, scope } = props
  // The current address (initialized from the persisted tab.path so a
  // reload restores the visited page).
  const [url, setUrl] = useState<string | undefined>(tab.path)
  const [input, setInput] = useState<string>(tab.path ?? '')
  /** Blocked/invalid hint shown under the address bar (null = none). */
  const [message, setMessage] = useState<string | null>(null)
  /** Address-bar navigation history (in-frame clicks are not tracked). */
  const [history, setHistory] = useState<string[]>(tab.path !== undefined ? [tab.path] : [])
  const [cursor, setCursor] = useState<number>(tab.path !== undefined ? 0 : -1)
  /** Bumped on reload to remount the iframe (also remounts on sandbox flip). */
  const [reloadKey, setReloadKey] = useState(0)
  /** TEMPORARY sandbox unlock for THIS surface only (never writes the global
   *  side card setting; lasts until the tab unmounts or the user restores). */
  const [localUnlock, setLocalUnlock] = useState(false)
  const noSandbox = store.getPrefs().browserNoSandbox === true || localUnlock
  /** A site that refuses to be embedded (X-Frame-Options / frame-ancestors):
   *  the probe verdict shown instead of the blank iframe. */
  const [embedBlocked, setEmbedBlocked] = useState<string | null>(null)
  /** The user asked to load the refused site anyway (keeps the plain iframe). */
  const [forceEmbed, setForceEmbed] = useState(false)
  /** The live iframe (the element picker posts into its contentWindow). */
  const frameRef = useRef<HTMLIFrameElement>(null)
  // The element picker: enabled only once the framed document's bridge
  // answers the ready handshake (never for a cross-origin site).
  /** Whether the frame currently shows the picker proxy's copy of the page
   *  (opt-in per navigation: the crosshair turns it on, a navigation or the
   *  restore action turns it off). */
  const [proxied, setProxied] = useState(false)
  /** The proxy route's capability token (fetched over the fenced API when the
   *  crosshair asks for proxied picking; the sandboxed frame's navigation
   *  carries Origin: null, which the route's fence refuses on its own). */
  const [proxyToken, setProxyToken] = useState<string | null>(null)
  const picker = useElementPicker({
    frame: () => frameRef.current,
    // A proxied document lives on this plugin's route; the capture must still
    // name the site the user is looking at.
    pageUrl: () => url,
    onPicked: (element) => {
      // ZCode numbers its blocks inside one "# Web page elements:" section;
      // reading the draft first keeps that numbering when several elements are
      // picked into the same message.
      appendToDraft(ctx, scope.sessionId, buildWebElementInsert(element, readDraft(ctx, scope.sessionId)), '\n\n')
    },
  })
  /** Whether this address could be re-served by the picker proxy at all. */
  const canProxy = isProxyablePage(url)
  /** Static mode: the proxy strips the page's own scripts (the escape hatch
   *  for a page that paints nothing under the proxy — frame-busters, canonical
   *  self-redirects, scripts that die in the sandbox's opaque origin). */
  const [proxyNoScript, setProxyNoScript] = useState(false)
  /** Leave proxy mode (a navigation, or the user restoring the direct load). */
  const leaveProxy = (): void => {
    if (proxied) {
      picker.cancel()
      setProxied(false)
      setProxyToken(null)
      setProxyNoScript(false)
    }
  }
  /** Stable handle so the Esc effect never re-subscribes on every render. */
  const leaveProxyRef = useRef<() => void>(() => {})
  leaveProxyRef.current = (): void => {
    leaveProxy()
    setReloadKey(key => key + 1)
  }
  /**
   * Enter proxy mode: arm the picker for the document the frame is ABOUT to load,
   * mint the capability token, then swap the src. The arming is what keeps the
   * session alive: the injected bridge announces itself while its document is
   * still parsing, and a session started on that announcement would be wiped by
   * the load event that follows it.
   */
  const startProxiedPicking = (): void => {
    picker.armForNextDocument()
    void fetchProxyToken().then((token) => {
      setProxyToken(token)
      setProxied(true)
    }).catch(() => {
      // Nothing will load, so disarm before reporting.
      picker.cancel()
      setMessage(t('pickElementProxyFailed'))
    })
  }
  /**
   * Esc while the frame is proxied but no session is running — the gap between
   * pressing the crosshair and the injected bridge answering, and the state left
   * after one capture — leaves proxy mode and restores the direct page. During a
   * live session the picker's own Esc handler cancels the capture first, so the
   * two layers peel off in the order the user expects.
   */
  const proxiedIdle = proxied && !picker.picking
  useEffect(() => {
    if (!proxiedIdle) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      leaveProxyRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [proxiedIdle])
  // Probe every navigation (address bar, history, restored path): when the
  // target forbids embedding, show the reason + open-in-browser instead of
  // the browser's cryptic "refused to connect" blank frame. A failed probe
  // (unreachable) keeps the plain iframe.
  useEffect(() => {
    if (url === undefined) return
    let cancelled = false
    setEmbedBlocked(null)
    setForceEmbed(false)
    void api.browserProbe(url).then((probe) => {
      if (!cancelled && embeddabilityOf(probe) === 'blocked') setEmbedBlocked(url)
    }).catch(() => { /* unreachable: keep the plain iframe */ })
    return () => { cancelled = true }
  }, [url])

  const persist = (nextUrl: string): void => {
    let host = nextUrl
    try { host = new URL(nextUrl).hostname } catch { /* keep the URL as title */ }
    store.reduce(state => patchTab(state, tab.id, { path: nextUrl, title: host }))
  }

  const navigateTo = (raw: string): void => {
    const result = normalizeBrowserUrl(raw, window.location.origin)
    if (result.kind === 'ok') {
      leaveProxy()
      const next = result.url
      setUrl(next)
      setInput(next)
      setMessage(null)
      // Push onto the stack, dropping any stale forward entries.
      setHistory(previous => [...previous.slice(0, cursor + 1), next])
      setCursor(previous => previous + 1)
      setReloadKey(key => key + 1)
      persist(next)
      return
    }
    setMessage(result.kind === 'invalid'
      ? t('browserInvalid')
      : result.reason === 'scheme' ? t('browserBlockedScheme')
      : t('browserBlockedLoopback'))
  }

  const goBack = (): void => {
    if (cursor <= 0) return
    leaveProxy()
    const next = history[cursor - 1]!
    setCursor(cursor - 1)
    setUrl(next)
    setInput(next)
    setReloadKey(key => key + 1)
  }

  const goForward = (): void => {
    if (cursor >= history.length - 1) return
    leaveProxy()
    const next = history[cursor + 1]!
    setCursor(cursor + 1)
    setUrl(next)
    setInput(next)
    setReloadKey(key => key + 1)
  }

  return (
    <div className={css.browser}>
      <div className={css.browserBar}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserBack')}
          title={t('browserBack')}
          disabled={cursor <= 0}
          onClick={goBack}
        >
          <IconChevronLeftOutline14 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserForward')}
          title={t('browserForward')}
          disabled={cursor >= history.length - 1}
          onClick={goForward}
        >
          <IconChevronRightOutline14 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { setReloadKey(key => key + 1) }}
        >
          <IconRefreshOutline14 />
        </button>
        <input
          className={css.browserInput}
          value={input}
          placeholder={t('browserPlaceholder')}
          spellCheck={false}
          onChange={event => { setInput(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') navigateTo(input)
          }}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserGo')}
          title={t('browserGo')}
          onClick={() => { navigateTo(input) }}
        >
          <IconLinkOutline14 />
        </button>
        <button
          type="button"
          className={clsx(css.iconButton, picker.picking && css.iconButtonActive)}
          aria-label={picker.picking ? t('pickElementCancel') : t('pickElement')}
          title={picker.picking
            ? t('pickElementCancel')
            : picker.ready ? t('pickElement')
            : canProxy ? t('pickElementViaProxy')
            : t('pickElementUnsupported')}
          disabled={url === undefined || (!picker.ready && !canProxy)}
          aria-pressed={picker.picking}
          onClick={() => {
            // Direct load with a bridge (a page we serve) or a live session:
            // plain toggle. A remote page has no bridge — re-serve it through
            // the proxy first and start once it answers.
            if (picker.ready || picker.picking || proxied) {
              picker.toggle()
              return
            }
            startProxiedPicking()
          }}
        >
          <IconCrosshairOutline16 size={15} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('browserOpenExternal')}
          title={t('browserOpenExternal')}
          disabled={url === undefined}
          onClick={() => {
            if (url !== undefined) window.open(url, '_blank', 'noopener')
          }}
        >
          <IconRightUpOutline16 size={15} />
        </button>
      </div>
      {proxied && (
        <div className={css.browserMessage}>
          {proxyNoScript ? t('browserProxyStaticNotice') : t('browserProxyNotice')}
          {!proxyNoScript && (
            <button
              type="button"
              className={css.browserProxyRestore}
              onClick={() => {
                // A blank/broken proxied page: retry without the page's scripts,
                // and arm the picker for that reload.
                picker.armForNextDocument()
                setProxyNoScript(true)
                setReloadKey(key => key + 1)
              }}
            >
              {t('browserProxyStatic')}
            </button>
          )}
          <button
            type="button"
            className={css.browserProxyRestore}
            onClick={() => { leaveProxy(); setReloadKey(key => key + 1) }}
          >
            {t('browserProxyRestore')}
          </button>
        </div>
      )}
      {(message ?? picker.notice) !== null && (
        <div className={css.browserMessage}>{message ?? picker.notice}</div>
      )}
      <SandboxStatusBar
        sandboxed={!noSandbox}
        local={localUnlock}
        dangerCopy={t('browserNoSandboxWarning')}
        onUnlock={() => { setLocalUnlock(true) }}
        onRestore={() => { setLocalUnlock(false) }}
      />
      {url === undefined ? (
        <div className={css.browserStart}>{t('browserStart')}</div>
      ) : embedBlocked !== null && !forceEmbed && !proxied ? (
        <BrowserEmbedBlocked
          url={embedBlocked}
          onOpenInBrowser={() => { window.open(embedBlocked, '_blank', 'noopener') }}
          onLoadAnyway={() => { setForceEmbed(true) }}
        />
      ) : (
        <iframe
          key={`${reloadKey}:${noSandbox ? 'ns' : 'sb'}:${proxied ? 'px' : 'dx'}:${proxyNoScript ? 'ns0' : 'js'}`}
          ref={frameRef}
          className={css.browserFrame}
          src={proxied && proxyToken !== null
            ? encodeProxyUrl(url, proxyToken, proxyNoScript)
            : url}
          sandbox={noSandbox ? undefined : BROWSER_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          allow=""
          title={url}
          onLoad={picker.handleLoad}
        />
      )}
    </div>
  )
}

/**
 * The embed-refusal panel: shown when the probed site forbids being
 * displayed inside other pages (X-Frame-Options / frame-ancestors) — the
 * iframe would only show the browser's "refused to connect" blank. Explains
 * the reason and offers the real-browser open plus a load-anyway escape.
 * Exported so the copy and the actions are testable without a DOM.
 */
export function BrowserEmbedBlocked(props: {
  url: string
  onOpenInBrowser: () => void
  onLoadAnyway: () => void
}) {
  const { url, onOpenInBrowser, onLoadAnyway } = props
  let host = url
  try { host = new URL(url).hostname } catch { /* keep the raw URL */ }
  return (
    <div className={css.browserBlocked}>
      <IconWarningOutline16 size={16} />
      <div className={css.browserBlockedTitle}>{t('browserEmbedBlocked', { host })}</div>
      <div className={css.browserBlockedDesc}>{t('browserEmbedBlockedDesc')}</div>
      <div className={css.browserBlockedActions}>
        <button type="button" className={css.browserBlockedButton} onClick={onOpenInBrowser}>
          {t('browserOpenExternal')}
        </button>
        <button type="button" className={css.browserBlockedButton} onClick={onLoadAnyway}>
          {t('browserEmbedAnyway')}
        </button>
      </div>
    </div>
  )
}
