import { shell, type BrowserWindow } from 'electron'
import {
  anthropicOAuthProvider,
  loginAnthropic,
  loginOpenAICodex,
  openaiCodexOAuthProvider,
  refreshAnthropicToken,
  refreshOpenAICodexToken,
  type OAuthCredentials
} from '@mariozechner/pi-ai/oauth'
import type { Settings, SubStatus, SubWhich } from '@shared/types'
import { saveSettings } from './store'

const oauthProviders = { anthropic: anthropicOAuthProvider, codex: openaiCodexOAuthProvider } as const

export function subStatus(settings: Settings): SubStatus {
  const one = (w: SubWhich) => {
    const c = settings.subscriptions?.[w]
    return { signedIn: !!c?.access, expires: c?.expires ?? 0 }
  }
  return { anthropic: one('anthropic'), codex: one('codex') }
}

/** Valid API key for a subscription provider, refreshing (and persisting) the token when near expiry. */
export async function getValidApiKey(settings: Settings, which: SubWhich): Promise<string | null> {
  let creds = settings.subscriptions?.[which]
  if (!creds?.access) return null
  if (creds.expires < Date.now() + 60_000) {
    creds = which === 'anthropic' ? await refreshAnthropicToken(creds.refresh) : await refreshOpenAICodexToken(creds.refresh)
    settings.subscriptions = { ...settings.subscriptions, [which]: creds }
    await saveSettings(settings)
  }
  return oauthProviders[which].getApiKey(creds)
}

export async function logout(settings: Settings, which: SubWhich): Promise<void> {
  if (settings.subscriptions) delete settings.subscriptions[which]
  await saveSettings(settings)
}

// One shared pending prompt: pi-ai asks for manual input via onManualCodeInput and/or onPrompt;
// both await the same renderer paste, and the browser callback races against it.
interface PendingCode {
  which: SubWhich
  promise: Promise<string>
  resolve: (code: string) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}
let pendingCode: PendingCode | null = null

function waitForCode(which: SubWhich): Promise<string> {
  if (pendingCode?.which === which) return pendingCode.promise
  clearPending()
  let resolve!: (code: string) => void
  let reject!: (e: Error) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {}) // login may finish via the browser callback; avoid unhandled rejections
  const timer = setTimeout(() => {
    if (pendingCode?.timer === timer) {
      pendingCode = null
      reject(new Error('Sign-in timed out — please try again'))
    }
  }, 10 * 60_000)
  pendingCode = { which, promise, resolve, reject, timer }
  return promise
}

function clearPending() {
  if (!pendingCode) return
  clearTimeout(pendingCode.timer)
  pendingCode = null
}

export function submitCode(code: string): boolean {
  if (!pendingCode || !code.trim()) return false
  const p = pendingCode
  clearPending()
  p.resolve(code.trim())
  return true
}

export async function startLogin(win: BrowserWindow, settings: Settings, which: SubWhich): Promise<void> {
  const send = (ch: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(ch, payload)
  }
  const callbacks = {
    onAuth: (info: { url: string; instructions?: string }) => {
      void shell.openExternal(info.url)
      send('subs:auth', { which, url: info.url, instructions: info.instructions })
    },
    onProgress: (message: string) => send('subs:auth', { which, progress: message }),
    onPrompt: () => waitForCode(which),
    onManualCodeInput: () => waitForCode(which)
  }
  try {
    const creds: OAuthCredentials =
      which === 'anthropic' ? await loginAnthropic(callbacks) : await loginOpenAICodex({ ...callbacks, originator: 'pc-ai' })
    settings.subscriptions = { ...settings.subscriptions, [which]: creds }
    await saveSettings(settings)
    send('subs:done', { which, ok: true })
  } catch (e: any) {
    send('subs:done', { which, ok: false, error: String(e?.message ?? e) })
  } finally {
    if (pendingCode?.which === which) clearPending()
  }
}
