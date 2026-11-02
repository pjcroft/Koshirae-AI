import { randomUUID } from 'crypto'
import { homedir, platform } from 'os'
import type { BrowserWindow } from 'electron'
import type { ChatEvent, ChatMessage, Conversation, Provider, Settings, ToolCall } from '@shared/types'
import { builtinTools, ToolDef } from './tools'
import { mcpTools } from './mcp'
import { saveConv } from './store'
import { getModels, stream } from '@mariozechner/pi-ai'
import type { AssistantMessage as PiAssistantMessage, Context as PiContext, Message as PiMessage, Model as PiModel, Tool as PiTool } from '@mariozechner/pi-ai'
import { getValidApiKey } from './subs'

const pending = new Map<string, (allow: boolean) => void>()
const running = new Map<string, AbortController>()

export const respondApproval = (id: string, allow: boolean) => {
  pending.get(id)?.(allow)
  pending.delete(id)
}
export const deleted = new Set<string>()
export const isRunning = (id: string) => running.has(id)
export const stopAll = () => running.forEach((a) => a.abort())
export const stopConv = (id: string) => {
  running.get(id)?.abort()
}

const headers = (p: Provider): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`
  if (p.baseUrl.includes('openrouter.ai')) {
    h['HTTP-Referer'] = 'https://pjcroft.ddnsfree.com'
    h['X-Title'] = 'PC AI'
  }
  return h
}
const base = (p: Provider) => p.baseUrl.replace(/\/+$/, '')

export async function listModels(p: Provider): Promise<string[]> {
  if (p.kind === 'claude-sub') return getModels('anthropic').map((m) => m.id).sort()
  if (p.kind === 'chatgpt-sub') return getModels('openai-codex').map((m) => m.id).sort()
  const r = await fetch(base(p) + '/models', { headers: headers(p) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j: any = await r.json()
  return (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean).sort()
}

async function streamCompletion(
  p: Provider,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  onDelta: (t: string) => void
): Promise<ChatMessage> {
  const body: any = { model, messages, stream: true }
  if (tools.length)
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  let content = ''
  const calls: ToolCall[] = []
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
  const r = await fetch(base(p) + '/chat/completions', {
    method: 'POST',
    headers: headers(p),
    body: JSON.stringify(body),
    signal
  })
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`)
  reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) buf += '\n'
      else buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let j: any
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error))
        const d = j.choices?.[0]?.delta
        if (!d) continue
        if (d.content) {
          content += d.content
          onDelta(d.content)
        }
        for (const tc of d.tool_calls ?? []) {
          let slot = tc.index
          if (slot === undefined) {
            // no index: a new id (or first sighting) starts a new call
            slot = tc.id && calls.some((x) => x && x.id === tc.id) ? calls.findIndex((x) => x && x.id === tc.id) : tc.id || !calls.length ? calls.length : calls.length - 1
          }
          const c = (calls[slot] ??= {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' }
          })
          if (tc.id) c.id = tc.id
          if (tc.function?.name && !c.function.name.endsWith(tc.function.name)) c.function.name += tc.function.name
          if (tc.function?.arguments) c.function.arguments += tc.function.arguments
        }
      }
      if (done) break
    }
  } catch (e) {
    if (!signal.aborted) throw e
  } finally {
    reader?.cancel().catch(() => {})
  }
  const real = calls.filter(Boolean).map((c) => ({ ...c, id: c.id || randomUUID().slice(0, 12) }))
  const msg: ChatMessage = { role: 'assistant', content: content || null }
  if (real.length && !signal.aborted) msg.tool_calls = real
  return msg
}

// ---- Subscription providers (Claude Pro/Max, ChatGPT Plus/Pro) via pi-ai ----

const emptyUsage = (): PiAssistantMessage['usage'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

function toPiMessages(messages: ChatMessage[], model: PiModel<any>): PiMessage[] {
  const now = Date.now()
  const out: PiMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }], timestamp: now })
    } else if (m.role === 'assistant') {
      const content: PiAssistantMessage['content'] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, any> = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {}
        content.push({ type: 'toolCall', id: tc.id, name: tc.function.name, arguments: args })
      }
      if (!content.length) content.push({ type: 'text', text: '' })
      out.push({
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: 'stop',
        timestamp: now
      })
    } else if (m.role === 'tool') {
      out.push({
        role: 'toolResult',
        toolCallId: m.tool_call_id ?? '',
        toolName: m.name ?? '',
        content: [{ type: 'text', text: m.content ?? '' }],
        isError: false,
        timestamp: now
      })
    }
  }
  return out
}

async function streamSubCompletion(
  settings: Settings,
  p: Provider,
  modelId: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  onDelta: (t: string) => void
): Promise<ChatMessage> {
  const which = p.kind === 'claude-sub' ? 'anthropic' : 'codex'
  const apiKey = await getValidApiKey(settings, which)
  if (!apiKey)
    throw new Error(
      `Not signed in — open Settings → Subscription accounts and sign in with ${which === 'anthropic' ? 'Claude' : 'ChatGPT'} first.`
    )
  const all = (which === 'anthropic' ? getModels('anthropic') : getModels('openai-codex')) as PiModel<any>[]
  const model = all.find((m) => m.id === modelId)
  if (!model) throw new Error(`Unknown model for ${p.name}: ${modelId}`)
  const sys = messages.find((m) => m.role === 'system')
  const ctx: PiContext = {
    systemPrompt: typeof sys?.content === 'string' ? sys.content : undefined,
    messages: toPiMessages(messages.filter((m) => m.role !== 'system'), model),
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }) as unknown as PiTool)
  }
  const events = stream(model, ctx, { apiKey, signal })
  for await (const ev of events) if (ev.type === 'text_delta') onDelta(ev.delta)
  const final = await events.result()
  if (final.stopReason === 'error' && !signal.aborted) throw new Error(final.errorMessage || 'Subscription provider error')
  let content = ''
  const calls: ToolCall[] = []
  for (const b of final.content) {
    if (b.type === 'text') content += b.text
    else if (b.type === 'toolCall')
      calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.arguments ?? {}) } })
  }
  const msg: ChatMessage = { role: 'assistant', content: content || null }
  if (calls.length && !signal.aborted) msg.tool_calls = calls
  return msg
}

function repairOrphans(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  msgs.forEach((m, i) => {
    out.push(m)
    if (m.role === 'assistant' && m.tool_calls) {
      const answered = new Set<string>()
      for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) answered.add(msgs[j].tool_call_id!)
      for (const tc of m.tool_calls)
        if (!answered.has(tc.id))
          out.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: 'Cancelled (no result recorded).' })
    }
  })
  return out
}

export async function runAgent(
  win: BrowserWindow,
  conv: Conversation,
  settings: Settings,
  provider: Provider,
  model: string
) {
  const ac = new AbortController()
  running.set(conv.id, ac)
  const emit = (e: ChatEvent) => !win.isDestroyed() && win.webContents.send('chat:event', e)
  const push = async (m: ChatMessage) => {
    if (deleted.has(conv.id)) return
    conv.messages.push(m)
    conv.updatedAt = Date.now()
    await saveConv(conv)
    emit({ convId: conv.id, type: 'message', message: m })
  }

  const sys: ChatMessage = {
    role: 'system',
    content:
      `${settings.systemPrompt}\n\nEnvironment: ${platform()}, home ${homedir()}, working dir ${settings.workingDir}, date ${new Date().toDateString()}.`
  }

  try {
    for (let iter = 0; iter < 25 && !ac.signal.aborted; iter++) {
      const tools = [...builtinTools, ...mcpTools()]
      const isSub = provider.kind === 'claude-sub' || provider.kind === 'chatgpt-sub'
      const msg = isSub
        ? await streamSubCompletion(
            settings,
            provider,
            model,
            [sys, ...repairOrphans(conv.messages)],
            tools,
            ac.signal,
            (text) => emit({ convId: conv.id, type: 'delta', text })
          )
        : await streamCompletion(
            provider,
            model,
            [sys, ...repairOrphans(conv.messages)],
            tools,
            ac.signal,
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
          try {
            args = JSON.parse(tc.function.arguments || '{}')
          } catch {
            args = null
          }
          if (args === null) result = 'Error: arguments were not valid JSON.'
          else {
            let allowed = settings.policy[tool.category] === 'allow'
            if (!allowed) {
              const id = randomUUID()
              emit({
                convId: conv.id,
                type: 'approval',
                id,
                toolCallId: tc.id,
                name: tc.function.name,
                args: tc.function.arguments,
                category: tool.category
              })
              allowed = await new Promise<boolean>((res) => {
                pending.set(id, res)
                ac.signal.addEventListener('abort', () => res(false), { once: true })
              })
            }
            if (!allowed) result = ac.signal.aborted ? 'Cancelled by user.' : 'The user denied this tool call.'
            else {
              try {
                result = await tool.run(args, { settings, signal: ac.signal })
              } catch (e: any) {
                result = `Error: ${e?.message ?? e}`
              }
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
