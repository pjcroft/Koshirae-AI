// Browser/Android implementation of the desktop `window.api` (src/shared/types.ts).
// Everything runs inside the WebView: settings + chats live in app-private
// storage (localStorage / IndexedDB), model calls go straight from the phone
// to the provider, and tools are limited to what a phone can do (HTTP fetch,
// web search via SearXNG, and MCP servers over HTTP).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  Api, ChatEvent, ChatMessage, Conversation, ConversationMeta, McpStatus, Provider, Settings, ToolCategory
} from '@shared/types'
import { listHttpModels, repairOrphans, streamCompletion, type ToolSpec } from '@shared/llm'
import { capDocText } from '@shared/files'

const MOBILE_PROMPT =
  "You are Koshirae AI, a capable assistant running on the user's Android phone. You can fetch web pages, search the web (when the user has configured SearXNG), and use any MCP tools the user connected. You cannot access files, shell, SSH or SMB on this device — if asked, say so and suggest the desktop app. Be concise: replies are read on a small screen.\n\n" +
  'Attachments are handled by the app, not by you: when the user attaches a file (PDF, Word, Excel, text) its text is extracted and given to you inline where possible. Images arrive as image parts: if you are a vision-capable model, use them; if you are a text-only model, say exactly that and suggest switching to a vision model.'

const defaultSettings = (): Settings => ({
  providers: [{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' }],
  activeProviderId: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5',
  enabledModels: {},
  systemPrompt: MOBILE_PROMPT,
  workingDir: '',
  projects: [],
  policy: { read: 'allow', write: 'ask', exec: 'ask', mcp: 'ask' },
  mcpServers: [],
  smb: [],
  searxngUrl: '',
  voiceCleanup: false,
  voiceCleanupProvider: '',
  voiceCleanupModel: '',
  subscriptions: {}
})

// ---------- storage ----------
const SETTINGS_KEY = 'koshirae.settings'
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const s = { ...defaultSettings(), ...JSON.parse(raw) } as Settings
      s.providers = s.providers.filter((p) => !p.kind || p.kind === 'api') // no subscription logins on the phone
      return s
    }
  } catch {}
  return defaultSettings()
}
let settings = loadSettings()
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))

let dbp: Promise<IDBDatabase> | undefined
const db = () =>
  (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('koshirae', 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore('convs', { keyPath: 'id' })
      r.result.createObjectStore('meta', { keyPath: 'id' })
    }
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))
async function tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise((res, rej) => {
    const q = f(d.transaction(store, mode).objectStore(store))
    q.onsuccess = () => res(q.result)
    q.onerror = () => rej(q.error)
  })
}
const saveConv = async (c: Conversation) => {
  await tx('convs', 'readwrite', (s) => s.put(c))
  await tx('meta', 'readwrite', (s) => s.put({ id: c.id, title: c.title, updatedAt: c.updatedAt, projectId: c.projectId }))
}
const loadConv = (id: string) => tx<Conversation | undefined>('convs', 'readonly', (s) => s.get(id)).then((c) => c ?? null)

// ---------- events / approvals ----------
const listeners = new Set<(e: ChatEvent) => void>()
const emit = (e: ChatEvent) => listeners.forEach((l) => l(e))
const pending = new Map<string, (allow: boolean) => void>()
const running = new Map<string, AbortController>()
const deleted = new Set<string>()

// ---------- tools ----------
interface MTool extends ToolSpec {
  category: ToolCategory
  run: (args: any, signal: AbortSignal) => Promise<string>
}
const MAX_OUT = 40_000
const clip = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s)
const str = (description: string) => ({ type: 'string', description })

const builtin = (): MTool[] => [
  {
    name: 'http_fetch',
    description: 'HTTP GET a URL (including Tailscale/LAN addresses the phone can reach) and return the text body.',
    parameters: { type: 'object', properties: { url: str('http(s) URL') }, required: ['url'] },
    category: 'exec',
    run: async ({ url }, signal) => {
      const r = await fetch(url, { signal })
      return `HTTP ${r.status}\n` + clip(await r.text())
    }
  },
  {
    name: 'web_search',
    description:
      "Search the web using the user's SearXNG instance. Use for current information. Returns titles, URLs and snippets; follow up with http_fetch to read a page.",
    parameters: {
      type: 'object',
      properties: { query: str('Search query'), count: { type: 'number', description: 'Results to return (1–15, default 8)' } },
      required: ['query']
    },
    category: 'read',
    run: async ({ query, count }, signal) => {
      const base = (settings.searxngUrl || '').trim().replace(/\/+$/, '')
      if (!base) return 'Web search is not configured. Set a SearXNG URL in Settings → Web search.'
      const n = Math.min(15, Math.max(1, Math.floor(Number(count)) || 8))
      try {
        const r = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&language=en`, {
          headers: { Accept: 'application/json' },
          signal
        })
        if (!r.ok) return `Error: SearXNG returned HTTP ${r.status}.`
        const data: any = await r.json()
        const results = Array.isArray(data?.results) ? data.results : []
        if (!results.length) return `No results found for "${query}".`
        return clip(
          results
            .slice(0, n)
            .map((x: any, i: number) => {
              const snip = String(x?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
              return `${i + 1}. ${String(x?.title ?? '').trim()}\n${String(x?.url ?? '').trim()}${snip ? `\n${snip}` : ''}`
            })
            .join('\n\n')
        )
      } catch (e: any) {
        if (signal.aborted) throw e
        return `Error: web search failed (${e?.message ?? e}). Check the SearXNG URL in Settings.`
      }
    }
  }
]

// MCP over HTTP only (a phone cannot spawn stdio servers).
interface LiveMcp { client: Client; tools: MTool[] }
let live: LiveMcp[] = []
let mcpStatusList: McpStatus[] = []
let mcpChain: Promise<unknown> = Promise.resolve()

async function doStartMcp(): Promise<McpStatus[]> {
  await Promise.all(live.map((l) => l.client.close().catch(() => {})))
  live = []
  mcpStatusList = await Promise.all(
    settings.mcpServers
      .filter((s) => s.enabled !== false)
      .map(async (s): Promise<McpStatus> => {
        if (!s.url) return { name: s.name, ok: false, tools: 0, error: 'Phone supports HTTP MCP servers only (set "url").' }
        let client: Client | undefined
        try {
          client = new Client({ name: 'koshirae-mobile', version: '0.1.0' })
          let timer: ReturnType<typeof setTimeout>
          await Promise.race([
            client.connect(new StreamableHTTPClientTransport(new URL(s.url))),
            new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('connect timeout')), 20_000)))
          ]).finally(() => clearTimeout(timer))
          const { tools } = await client.listTools()
          const prefix = s.name.replace(/[^a-zA-Z0-9_-]/g, '_')
          const used = new Set<string>()
          const c = client
          const defs: MTool[] = tools.map((t) => {
            let nm = `mcp__${prefix}__${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 60)
            while (used.has(nm)) nm = nm.slice(0, 56) + '_' + Math.random().toString(36).slice(2, 5)
            used.add(nm)
            return {
              name: nm,
              description: `[${s.name}] ${t.description ?? t.name}`,
              parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
              category: 'mcp' as const,
              run: async (args: any, signal: AbortSignal) => {
                const r: any = await c.callTool({ name: t.name, arguments: args }, undefined, { signal })
                const text = (r.content ?? []).map((x: any) => (x.type === 'text' ? x.text : `[${x.type} content]`)).join('\n')
                return clip(text) + (r.isError ? '\n[tool reported error]' : '')
              }
            }
          })
          live.push({ client, tools: defs })
          return { name: s.name, ok: true, tools: defs.length }
        } catch (e: any) {
          await client?.close().catch(() => {})
          return { name: s.name, ok: false, tools: 0, error: String(e?.message ?? e) }
        }
      })
  )
  return mcpStatusList
}
const startMcp = () => {
  const p = mcpChain.then(doStartMcp)
  mcpChain = p.catch(() => {})
  return p
}
void startMcp()

// ---------- agent loop ----------
async function runAgent(conv: Conversation, provider: Provider, model: string) {
  const ac = new AbortController()
  running.set(conv.id, ac)
  const push = async (m: ChatMessage) => {
    if (deleted.has(conv.id)) return
    conv.messages.push(m)
    conv.updatedAt = Date.now()
    await saveConv(conv)
    emit({ convId: conv.id, type: 'message', message: m })
  }
  const sys: ChatMessage = {
    role: 'system',
    content: `${settings.systemPrompt}\n\nEnvironment: Android phone, date ${new Date().toDateString()}.`
  }
  try {
    for (let iter = 0; iter < 25 && !ac.signal.aborted; iter++) {
      const tools = [...builtin(), ...live.flatMap((l) => l.tools)]
      const msg = await streamCompletion(
        provider, model, [sys, ...repairOrphans(conv.messages)], tools, ac.signal,
        (text) => emit({ convId: conv.id, type: 'delta', text })
      )
      if (msg.content || msg.tool_calls) await push(msg)
      if (!msg.tool_calls) break
      for (const tc of msg.tool_calls) {
        let result: string
        const tool = tools.find((t) => t.name === tc.function.name)
        if (ac.signal.aborted) result = 'Cancelled by user.'
        else if (!tool) result = `Unknown tool ${tc.function.name}`
        else {
          let args: any
          try { args = JSON.parse(tc.function.arguments || '{}') } catch { args = null }
          if (args === null) result = 'Error: arguments were not valid JSON.'
          else {
            let allowed = settings.policy[tool.category] === 'allow'
            if (!allowed) {
              const id = crypto.randomUUID()
              emit({ convId: conv.id, type: 'approval', id, toolCallId: tc.id, name: tc.function.name, args: tc.function.arguments, category: tool.category })
              allowed = await new Promise<boolean>((res) => {
                pending.set(id, res)
                ac.signal.addEventListener('abort', () => res(false), { once: true })
              })
            }
            if (!allowed) result = ac.signal.aborted ? 'Cancelled by user.' : 'The user denied this tool call.'
            else {
              try { result = await tool.run(args, ac.signal) } catch (e: any) { result = `Error: ${e?.message ?? e}` }
            }
          }
        }
        await push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result || '(no output)' })
      }
    }
    emit({ convId: conv.id, type: 'done' })
  } catch (e: any) {
    if (ac.signal.aborted) emit({ convId: conv.id, type: 'done' })
    else emit({ convId: conv.id, type: 'error', error: String(e?.message ?? e) })
  } finally {
    running.delete(conv.id)
  }
}

// ---------- documents (browser-side extraction) ----------
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

// ---------- the Api ----------
const noop = async () => {}
const api: Api = {
  mobile: true,
  getSettings: async () => settings,
  setSettings: async (s) => {
    const changed = JSON.stringify(s.mcpServers) !== JSON.stringify(settings.mcpServers)
    settings = { ...s, providers: s.providers.filter((p) => !p.kind || p.kind === 'api') }
    saveSettings()
    return changed ? startMcp() : mcpStatusList
  },
  listConvs: async () => {
    const all = await tx<ConversationMeta[]>('meta', 'readonly', (s) => s.getAll())
    return all.sort((a, b) => b.updatedAt - a.updatedAt)
  },
  getConv: loadConv,
  newConv: async (projectId) => {
    const c: Conversation = {
      id: crypto.randomUUID(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(),
      providerId: settings.activeProviderId, model: settings.model, ...(projectId ? { projectId } : {}), messages: []
    }
    await saveConv(c)
    return c
  },
  deleteConv: async (id) => {
    deleted.add(id)
    running.get(id)?.abort()
    await tx('convs', 'readwrite', (s) => s.delete(id))
    await tx('meta', 'readwrite', (s) => s.delete(id))
  },
  projectsPickDir: async () => null,
  projectsAdd: async (name, path) => ({ id: crypto.randomUUID(), name, path }),
  projectsRemove: noop,
  listModels: async (id) => {
    const p = settings.providers.find((x) => x.id === id) ?? settings.providers[0]
    if (!p) throw new Error('No provider configured')
    return listHttpModels(p)
  },
  send: async (a) => {
    const conv = await loadConv(a.convId)
    if (!conv) return void emit({ convId: a.convId, type: 'error', error: 'Conversation not found' })
    if (running.has(a.convId)) return
    const provider = settings.providers.find((p) => p.id === a.providerId) ?? settings.providers[0]
    if (!provider) return void emit({ convId: a.convId, type: 'error', error: 'No provider configured' })
    if (conv.messages.length === 0) conv.title = a.text.slice(0, 48) || 'New chat'
    conv.providerId = a.providerId
    conv.model = a.model
    conv.messages.push({
      role: 'user', content: a.text,
      ...(a.attachments?.length ? { attachments: a.attachments } : {}),
      ...(a.files?.length ? { files: a.files } : {})
    })
    await saveConv(conv)
    await runAgent(conv, provider, a.model)
  },
  stop: async (id) => void running.get(id)?.abort(),
  compactChat: async () => ({ ok: false, compacted: false, summaryUpTo: 0 }),
  respond: async (id, allow) => {
    pending.get(id)?.(allow)
    pending.delete(id)
  },
  mcpStatus: async () => mcpStatusList,
  subsStatus: async () => ({ anthropic: { signedIn: false, expires: 0 }, codex: { signedIn: false, expires: 0 } }),
  subsLogin: noop,
  subsSubmitCode: async () => false,
  subsLogout: async () => ({ anthropic: { signedIn: false, expires: 0 }, codex: { signedIn: false, expires: 0 } }),
  usageGet: async () => ({}),
  voiceTranscribe: async () => ({ ok: false, error: 'Voice dictation is not available on the phone build.' }),
  imagesNormalize: async () => ({ ok: false, error: 'Unsupported image format.' }),
  extractFile: async (name, kind, dataBase64) => {
    try {
      let raw = ''
      let pages: number | undefined
      const bytes = b64ToBytes(dataBase64)
      if (kind === 'text') raw = new TextDecoder().decode(bytes)
      else if (kind === 'docx') {
        const mammoth: any = await import('mammoth/mammoth.browser')
        raw = (await mammoth.extractRawText({ arrayBuffer: bytes.buffer })).value
      } else if (kind === 'xlsx') {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(bytes, { type: 'array' })
        raw = wb.SheetNames.map((n) => `## Sheet: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n')
      } else if (kind === 'pdf')
        raw = `[PDF "${name}" attached. Text extraction is not available on the phone; providers with native PDF support (OpenRouter, OpenAI) read the file directly.]`
      else return { ok: false, error: 'PowerPoint files are not supported on the phone build yet.' }
      const capped = capDocText(raw)
      if (!capped.text.trim()) return { ok: false, error: `No readable text found in ${name}.` }
      return { ok: true, text: capped.text, ...(pages ? { pages } : {}), ...(capped.truncated ? { truncated: true } : {}) }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  },
  voiceStatus: async () => ({ engineFound: false, modelPresent: false }),
  voiceDownloadModel: async () => ({ ok: false, error: 'Not available on the phone build.' }),
  onVoiceModelProgress: () => () => {},
  pickDir: async () => null,
  onEvent: (cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  onSubsAuth: () => () => {},
  onSubsDone: () => () => {}
}
;(window as unknown as { api: Api }).api = api
