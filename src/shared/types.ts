export interface Provider {
  id: string
  name: string
  baseUrl: string // OpenAI-compatible, e.g. https://openrouter.ai/api/v1
  apiKey: string
  kind?: 'api' | 'claude-sub' | 'chatgpt-sub'
}

export interface SubCreds {
  refresh: string
  access: string
  expires: number // ms epoch
  [key: string]: unknown
}

export type SubWhich = 'anthropic' | 'codex'

export interface SubStatus {
  anthropic: { signedIn: boolean; expires: number }
  codex: { signedIn: boolean; expires: number }
}

export interface SubsAuthEvent {
  which: SubWhich
  url?: string
  instructions?: string
  progress?: string
}

export interface SubsDoneEvent {
  which: SubWhich
  ok: boolean
  error?: string
}

export interface McpServerConfig {
  name: string
  command?: string // stdio
  args?: string[]
  env?: Record<string, string>
  url?: string // streamable HTTP
  enabled?: boolean
}

export interface SmbCredential {
  host: string
  username?: string
  password?: string
  domain?: string
}

export type ToolCategory = 'read' | 'write' | 'exec' | 'mcp'
export type Policy = 'ask' | 'allow'

export interface Project {
  id: string
  name: string
  path: string
}

export interface Settings {
  providers: Provider[]
  activeProviderId: string
  model: string
  enabledModels: Record<string, string[]> // per provider id; empty = show all
  systemPrompt: string
  workingDir: string
  projects: Project[]
  policy: Record<ToolCategory, Policy>
  mcpServers: McpServerConfig[]
  smb: SmbCredential[]
  subscriptions?: { anthropic?: SubCreds; codex?: SubCreds }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  providerId: string
  model: string
  projectId?: string
  messages: ChatMessage[]
  // Context compaction: `summary` stands in for the first `summaryUpTo`
  // entries of messages when a run is assembled. The full messages array is
  // always kept (on disk and in the UI) — only what is sent changes.
  summary?: string
  summaryUpTo?: number
}

export interface ConversationMeta {
  id: string
  title: string
  updatedAt: number
  projectId?: string
}

export type ChatEvent =
  | { convId: string; type: 'message'; message: ChatMessage }
  | { convId: string; type: 'delta'; text: string }
  | { convId: string; type: 'compacted'; summaryUpTo: number }
  | { convId: string; type: 'approval'; id: string; toolCallId: string; name: string; args: string; category: ToolCategory }
  | { convId: string; type: 'done' }
  | { convId: string; type: 'error'; error: string }

export interface McpStatus {
  name: string
  ok: boolean
  tools: number
  error?: string
}

export interface UsageLine {
  label: string
  value: string
}

export interface SourceUsage {
  ok: boolean
  error?: string
  lines: UsageLine[]
}

export interface UsageReport {
  openrouter?: SourceUsage
  claude?: SourceUsage
  chatgpt?: SourceUsage
}

export interface Api {
  getSettings(): Promise<Settings>
  setSettings(s: Settings): Promise<McpStatus[]>
  listConvs(): Promise<ConversationMeta[]>
  getConv(id: string): Promise<Conversation | null>
  newConv(projectId?: string): Promise<Conversation>
  deleteConv(id: string): Promise<void>
  projectsPickDir(): Promise<string | null>
  projectsAdd(name: string, path: string): Promise<Project>
  projectsRemove(id: string): Promise<void>
  listModels(providerId: string): Promise<string[]>
  send(args: { convId: string; text: string; providerId: string; model: string }): Promise<void>
  stop(convId: string): Promise<void>
  compactChat(convId: string): Promise<{ ok: boolean; compacted: boolean; summaryUpTo: number }>
  respond(id: string, allow: boolean): Promise<void>
  mcpStatus(): Promise<McpStatus[]>
  subsStatus(): Promise<SubStatus>
  subsLogin(which: SubWhich): Promise<void>
  subsSubmitCode(code: string): Promise<boolean>
  subsLogout(which: SubWhich): Promise<SubStatus>
  usageGet(): Promise<UsageReport>
  pickDir(): Promise<string | null>
  onEvent(cb: (e: ChatEvent) => void): () => void
  onSubsAuth(cb: (e: SubsAuthEvent) => void): () => void
  onSubsDone(cb: (e: SubsDoneEvent) => void): () => void
}
