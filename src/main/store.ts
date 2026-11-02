import { app, safeStorage } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { Conversation, ConversationMeta, Provider, Settings, SubCreds } from '@shared/types'

export const subProviders = (): Provider[] => [
  { id: 'claude-sub', name: 'Claude (subscription)', baseUrl: '', apiKey: '', kind: 'claude-sub' },
  { id: 'chatgpt-sub', name: 'ChatGPT (subscription)', baseUrl: '', apiKey: '', kind: 'chatgpt-sub' }
]

// Older saved settings predate subscription providers; make sure they exist.
export function ensureSubProviders(s: Settings): Settings {
  const providers = [...s.providers]
  for (const sp of subProviders())
    if (!providers.some((p) => p.kind === sp.kind)) providers.push({ ...sp })
  return providers.length === s.providers.length ? s : { ...s, providers }
}

export const defaultSettings = (): Settings => ({
  providers: [
    { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
    { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', apiKey: '' },
    { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', apiKey: '' },
    ...subProviders()
  ],
  activeProviderId: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5',
  enabledModels: {},
  systemPrompt:
    'You are Koshirae AI, a capable assistant running on the user\'s computer with tools for local files, shell commands, SSH, SMB shares, and Tailscale. Use tools when they help; be concise and careful with anything destructive.',
  workingDir: homedir(),
  projects: [],
  policy: { read: 'allow', write: 'ask', exec: 'ask', mcp: 'ask' },
  mcpServers: [],
  smb: [],
  searxngUrl: '',
  subscriptions: {}
})

const dir = () => app.getPath('userData')
const settingsFile = () => join(dir(), 'settings.json')
const convDir = () => join(dir(), 'conversations')

const ENC = 'enc:'
function encrypt(v: string): string {
  if (!v || !safeStorage.isEncryptionAvailable()) return v
  return ENC + safeStorage.encryptString(v).toString('base64')
}
function decrypt(v: string): string {
  if (!v.startsWith(ENC)) return v
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(ENC.length), 'base64'))
  } catch {
    return ''
  }
}

function mapSecrets(s: Settings, f: (v: string) => string): Settings {
  const mapCreds = (c?: SubCreds): SubCreds | undefined =>
    c ? { ...c, access: f(c.access || ''), refresh: f(c.refresh || '') } : c
  return {
    ...s,
    providers: s.providers.map((p) => ({ ...p, apiKey: f(p.apiKey || '') })),
    smb: s.smb.map((c) => ({ ...c, password: c.password ? f(c.password) : c.password })),
    subscriptions: s.subscriptions
      ? { anthropic: mapCreds(s.subscriptions.anthropic), codex: mapCreds(s.subscriptions.codex) }
      : s.subscriptions
  }
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    return ensureSubProviders(mapSecrets({ ...defaultSettings(), ...raw }, decrypt))
  } catch {
    return defaultSettings()
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await fs.mkdir(dir(), { recursive: true })
  const tmp = settingsFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(mapSecrets(s, encrypt), null, 2), { mode: 0o600 })
  await fs.rename(tmp, settingsFile())
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '')

export async function saveConv(c: Conversation): Promise<void> {
  await fs.mkdir(convDir(), { recursive: true })
  await fs.writeFile(join(convDir(), safeId(c.id) + '.json'), JSON.stringify(c))
}

export async function loadConv(id: string): Promise<Conversation | null> {
  try {
    return JSON.parse(await fs.readFile(join(convDir(), safeId(id) + '.json'), 'utf8'))
  } catch {
    return null
  }
}

export async function deleteConv(id: string): Promise<void> {
  await fs.rm(join(convDir(), safeId(id) + '.json'), { force: true })
}

export async function listConvs(): Promise<ConversationMeta[]> {
  try {
    const files = await fs.readdir(convDir())
    const out: ConversationMeta[] = []
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      try {
        const c: Conversation = JSON.parse(await fs.readFile(join(convDir(), f), 'utf8'))
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, projectId: c.projectId })
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}
