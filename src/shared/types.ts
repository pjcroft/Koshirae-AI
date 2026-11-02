export interface Provider {
  id: string
  name: string
  baseUrl: string // OpenAI-compatible, e.g. https://openrouter.ai/api/v1
  apiKey: string
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

export interface Settings {
  providers: Provider[]
  activeProviderId: string
  model: string
  enabledModels: Record<string, string[]> // per provider id; empty = show all
  systemPrompt: string
  workingDir: string
  policy: Record<ToolCategory, Policy>
  mcpServers: McpServerConfig[]
  smb: SmbCredential[]
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
  messages: ChatMessage[]
}

export interface ConversationMeta {
  id: string
  title: string
  updatedAt: number
}

export type ChatEvent =
  | { convId: string; type: 'message'; message: ChatMessage }
  | { convId: string; type: 'delta'; text: string }
  | { convId: string; type: 'approval'; id: string; toolCallId: string; name: string; args: string; category: ToolCategory }
  | { convId: string; type: 'done' }
  | { convId: string; type: 'error'; error: string }

export interface McpStatus {
  name: string
  ok: boolean
  tools: number
  error?: string
}

export interface Api {
  getSettings(): Promise<Settings>
  setSettings(s: Settings): Promise<McpStatus[]>
  listConvs(): Promise<ConversationMeta[]>
  getConv(id: string): Promise<Conversation | null>
  newConv(): Promise<Conversation>
  deleteConv(id: string): Promise<void>
  listModels(providerId: string): Promise<string[]>
  send(args: { convId: string; text: string; providerId: string; model: string }): Promise<void>
  stop(convId: string): Promise<void>
  respond(id: string, allow: boolean): Promise<void>
  mcpStatus(): Promise<McpStatus[]>
  pickDir(): Promise<string | null>
  onEvent(cb: (e: ChatEvent) => void): () => void
}
