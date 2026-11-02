import { arch, platform, release } from 'node:os'
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

/** Account id embedded in a ChatGPT OAuth access token (the JWT claim pi-ai reads), if present. */
export function codexAccountId(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Headers for chatgpt.com backend calls, mirroring pi-ai's Codex provider
 * (buildBaseCodexHeaders) exactly. A bare Authorization fetch from Node gets a
 * Cloudflare challenge page (HTTP 403 with an HTML body); this set is accepted.
 */
export function codexHeaders(token: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    originator: 'pi',
    'User-Agent': `pi (${platform()} ${release()}; ${arch()})`
  }
  if (accountId) headers['chatgpt-account-id'] = accountId
  return headers
}

// Mirrors the current Codex CLI version: the models endpoint serves a legacy
// list unless the client identifies a version, so send the CLI's.
const CODEX_CLIENT_VERSION = '0.166.0'

// Live Codex model list: pi-ai's static catalog goes stale between releases
// (e.g. GPT-5.5 retired from ChatGPT sign-in while the catalog still listed
// it), so prefer the account's real list from the backend. Cached for 10
// minutes, keyed by account id + credential expiry so a refresh or an account
// switch refetches.
let codexModelsCache: { ids: string[]; at: number; fingerprint: string } | null = null
const CODEX_MODELS_TTL_MS = 10 * 60_000

/** The account's live Codex model ids in backend order, or null when unavailable. */
export async function fetchLiveCodexModelIds(settings: Settings): Promise<string[] | null> {
  try {
    const token = await getValidApiKey(settings, 'codex')
    if (!token) return null
    const accountId = codexAccountId(token)
    const fingerprint = `${accountId ?? ''}:${settings.subscriptions?.codex?.expires ?? 0}`
    const now = Date.now()
    if (codexModelsCache && codexModelsCache.fingerprint === fingerprint && now - codexModelsCache.at < CODEX_MODELS_TTL_MS)
      return codexModelsCache.ids
    const r = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: codexHeaders(token, accountId),
      signal: AbortSignal.timeout(8_000)
    })
    if (!r.ok) return null
    const body: any = await r.json().catch(() => null)
    const entries: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.models)
        ? body.models
        : Array.isArray(body?.data)
          ? body.data
          : []
    const ids: string[] = []
    for (const e of entries) {
      // The backend marks internal models visibility:"hide"; only entries it
      // flags "list" (or doesn't flag at all) belong in the picker.
      if (e && typeof e === 'object' && 'visibility' in (e as any) && (e as any).visibility !== 'list') continue
      const raw = typeof e === 'string' ? e : (e as any)?.slug || (e as any)?.id || (e as any)?.model
      if (typeof raw === 'string' && raw && !ids.includes(raw)) ids.push(raw)
    }
    if (!ids.length) return null
    codexModelsCache = { ids, at: now, fingerprint }
    return ids
  } catch {
    return null
  }
}

// Live Claude model list, same reasoning as Codex: pi-ai's static catalog
// tops out a family behind (4.x while the current family is 5.x). Anthropic's
// /v1/models accepts the subscription OAuth bearer, so fetch the real list.
// Response order is newest-first — keep it, don't sort. Same 10-minute cache
// pattern as the Codex list, keyed by the anthropic credential expiry.
let anthropicModelsCache: { ids: string[]; at: number; fingerprint: string } | null = null
const ANTHROPIC_MODELS_TTL_MS = 10 * 60_000

/** The account's live Claude model ids, newest first, or null when unavailable. */
export async function fetchLiveAnthropicModelIds(settings: Settings): Promise<string[] | null> {
  try {
    const token = await getValidApiKey(settings, 'anthropic')
    if (!token) return null
    const fingerprint = `${settings.subscriptions?.anthropic?.expires ?? 0}`
    const now = Date.now()
    if (
      anthropicModelsCache &&
      anthropicModelsCache.fingerprint === fingerprint &&
      now - anthropicModelsCache.at < ANTHROPIC_MODELS_TTL_MS
    )
      return anthropicModelsCache.ids
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(8_000)
    })
    if (!r.ok) return null
    const body: any = await r.json().catch(() => null)
    const entries: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const ids: string[] = []
    for (const e of entries) {
      const raw = typeof e === 'string' ? e : (e as any)?.id
      if (typeof raw === 'string' && raw && !ids.includes(raw)) ids.push(raw)
    }
    if (!ids.length) return null
    anthropicModelsCache = { ids, at: now, fingerprint }
    return ids
  } catch {
    return null
  }
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
