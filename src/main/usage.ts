import type { Settings, SourceUsage, SubWhich, UsageLine, UsageReport } from '@shared/types'
import { codexAccountId, codexHeaders, getValidApiKey } from './subs'

// Usage visibility for the three metered sources: OpenRouter (API key) and the
// two subscription plans (Claude / ChatGPT). Every fetch is best-effort: a
// failing source reports its own error and never breaks the others, and no
// token value ever lands in the report.

const TIMEOUT_MS = 10_000

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(+v)) return +v
  return undefined
}
const money = (v: number) => `$${v.toFixed(2)}`
const pct = (v: number) => `${Math.round(v)}%`

/** resets_at / reset_at arrive as ISO strings or unix seconds (defensively also ms). */
function resetWhen(v: unknown): string {
  let ms: number | undefined
  const n = num(v)
  if (n !== undefined) ms = n > 1e11 ? n : n * 1000
  else if (typeof v === 'string') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) ms = t
  }
  if (ms === undefined) return ''
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

interface Fetched {
  status: number
  data: any
  gist: string
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<Fetched> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await r.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {}
  const gist =
    data?.error?.message ?? data?.error ?? data?.message ?? (text.length > 140 ? text.slice(0, 140) + '…' : text) ?? ''
  return { status: r.status, data, gist: typeof gist === 'string' ? gist : JSON.stringify(gist) }
}

const httpError = (f: Fetched) => `HTTP ${f.status}${f.gist ? ` — ${f.gist}` : ''}`

/** One plan window ("5-hour window", "23% used · resets 4:20 PM"). */
function windowLine(label: string, usedPct: number | undefined, reset: unknown): UsageLine | null {
  if (usedPct === undefined) return null
  const when = resetWhen(reset)
  return { label, value: `${pct(usedPct)} used${when ? ` · resets ${when}` : ''}` }
}

async function openrouterUsage(settings: Settings): Promise<SourceUsage | undefined> {
  const p =
    settings.providers.find((x) => x.baseUrl.includes('openrouter.ai')) ?? settings.providers.find((x) => x.id === 'openrouter')
  if (!p?.apiKey) return undefined
  const headers = { Authorization: `Bearer ${p.apiKey}` }
  const [key, credits] = await Promise.allSettled([
    fetchJson('https://openrouter.ai/api/v1/auth/key', headers),
    fetchJson('https://openrouter.ai/api/v1/credits', headers)
  ])
  const okFetch = (r: PromiseSettledResult<Fetched>) =>
    r.status === 'fulfilled' && r.value.status >= 200 && r.value.status < 300 ? r.value : null
  const keyOk = okFetch(key)
  const creditsOk = okFetch(credits)
  if (!keyOk && !creditsOk) {
    const fail = [key, credits].find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Fetched> | undefined
    const rej = [key, credits].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    return { ok: false, error: fail ? httpError(fail.value) : String(rej?.reason?.message ?? rej?.reason ?? 'Request failed'), lines: [] }
  }
  const lines: UsageLine[] = []
  const usage = num(keyOk?.data?.data?.usage)
  if (usage !== undefined) lines.push({ label: 'Used', value: money(usage) })
  const totalCredits = num(creditsOk?.data?.data?.total_credits)
  const totalUsage = num(creditsOk?.data?.data?.total_usage)
  if (totalCredits !== undefined && totalUsage !== undefined)
    lines.push({ label: 'Credits left', value: money(totalCredits - totalUsage) })
  const limit = keyOk?.data?.data?.limit
  if (limit !== null && limit !== undefined && num(limit) !== undefined) lines.push({ label: 'Limit', value: money(num(limit)!) })
  return { ok: true, lines }
}

async function subToken(settings: Settings, which: SubWhich): Promise<{ token?: string; error?: string }> {
  try {
    const t = await getValidApiKey(settings, which)
    return t ? { token: t } : { error: 'Not signed in' }
  } catch (e: any) {
    return { error: `Sign-in needs attention (${String(e?.message ?? e)})` }
  }
}

async function claudeUsage(settings: Settings): Promise<SourceUsage | undefined> {
  if (!settings.subscriptions?.anthropic) return undefined
  const { token, error } = await subToken(settings, 'anthropic')
  if (!token) return { ok: false, error: error ?? 'Not signed in', lines: [] }
  const f = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01'
  })
  if (f.status < 200 || f.status >= 300) return { ok: false, error: httpError(f), lines: [] }
  const d = f.data ?? {}
  const lines: UsageLine[] = []
  const five = windowLine('5-hour window', num(d.five_hour?.utilization), d.five_hour?.resets_at)
  if (five) lines.push(five)
  const seven = windowLine('7-day window', num(d.seven_day?.utilization), d.seven_day?.resets_at)
  if (seven) lines.push(seven)
  const sonnet = windowLine('7-day window · Sonnet', num(d.seven_day_sonnet?.utilization), d.seven_day_sonnet?.resets_at)
  if (sonnet) lines.push(sonnet)
  if (!lines.length) return { ok: false, error: 'Usage data not available', lines: [] }
  return { ok: true, lines }
}

function windowLabel(seconds: unknown, fallback: string): string {
  const s = num(seconds)
  if (s === undefined) return fallback
  if (s === 18_000) return '5-hour window'
  if (s === 604_800) return '7-day window'
  if (s % 86_400 === 0) return `${s / 86_400}-day window`
  if (s % 3_600 === 0) return `${s / 3_600}-hour window`
  return fallback
}

async function chatgptUsage(settings: Settings): Promise<SourceUsage | undefined> {
  if (!settings.subscriptions?.codex) return undefined
  const { token, error } = await subToken(settings, 'codex')
  if (!token) return { ok: false, error: error ?? 'Not signed in', lines: [] }
  // Full pi-ai Codex header set (see codexHeaders in subs.ts): a bare
  // Authorization fetch draws a Cloudflare challenge (HTTP 403 HTML page).
  const headers = codexHeaders(token, codexAccountId(token))
  let f = await fetchJson('https://chatgpt.com/backend-api/codex/usage', headers)
  if (f.status === 404) f = await fetchJson('https://chatgpt.com/backend-api/wham/usage', headers)
  if (f.status < 200 || f.status >= 300) return { ok: false, error: httpError(f), lines: [] }
  const d = f.data ?? {}
  const lines: UsageLine[] = []
  if (typeof d.plan_type === 'string' && d.plan_type) lines.push({ label: 'Plan', value: d.plan_type })
  const rl = d.rate_limit ?? d
  const primary = windowLine(
    windowLabel(rl?.primary_window?.limit_window_seconds, 'Primary window'),
    num(rl?.primary_window?.used_percent ?? rl?.primary_window?.usedPercent),
    rl?.primary_window?.reset_at ?? rl?.primary_window?.resets_at
  )
  if (primary) lines.push(primary)
  const secondary = windowLine(
    windowLabel(rl?.secondary_window?.limit_window_seconds, 'Secondary window'),
    num(rl?.secondary_window?.used_percent ?? rl?.secondary_window?.usedPercent),
    rl?.secondary_window?.reset_at ?? rl?.secondary_window?.resets_at
  )
  if (secondary) lines.push(secondary)
  if (!lines.length) return { ok: false, error: 'Usage data not available', lines: [] }
  return { ok: true, lines }
}

export async function getUsage(settings: Settings): Promise<UsageReport> {
  const safe = async (fn: (s: Settings) => Promise<SourceUsage | undefined>): Promise<SourceUsage | undefined> => {
    try {
      return await fn(settings)
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e), lines: [] }
    }
  }
  const [openrouter, claude, chatgpt] = await Promise.all([
    safe(openrouterUsage),
    safe(claudeUsage),
    safe(chatgptUsage)
  ])
  const report: UsageReport = {}
  if (openrouter) report.openrouter = openrouter
  if (claude) report.claude = claude
  if (chatgpt) report.chatgpt = chatgpt
  return report
}
