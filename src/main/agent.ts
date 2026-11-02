import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import type { ChatEvent, ChatMessage, Conversation, Provider, Settings, ToolCall } from '@shared/types'
import { builtinTools, ToolDef } from './tools'
import { mcpTools } from './mcp'
import { saveConv } from './store'
import { getModels, stream } from '@mariozechner/pi-ai'
import type { AssistantMessage as PiAssistantMessage, Context as PiContext, Message as PiMessage, Model as PiModel, Tool as PiTool } from '@mariozechner/pi-ai'
import { fetchLiveAnthropicModelIds, fetchLiveCodexModelIds, getValidApiKey } from './subs'

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
    h['X-Title'] = 'Koshirae AI'
  }
  return h
}
const base = (p: Provider) => p.baseUrl.replace(/\/+$/, '')

export async function listModels(p: Provider, settings?: Settings): Promise<string[]> {
  if (p.kind === 'claude-sub') {
    // Prefer the account's live list — pi-ai's static catalog goes stale the
    // same way the Codex one did. The live list is newest-first; keep its order.
    if (settings) {
      const live = await fetchLiveAnthropicModelIds(settings)
      if (live?.length) return live
    }
    return getModels('anthropic').map((m) => m.id).sort()
  }
  if (p.kind === 'chatgpt-sub') {
    // Prefer the account's live list from the backend — pi-ai's static catalog
    // goes stale (models retire / new families land between releases).
    if (settings) {
      const live = await fetchLiveCodexModelIds(settings)
      if (live?.length) return live
    }
    return getModels('openai-codex').map((m) => m.id).sort()
  }
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
  const resolved = resolvePiModel(p, modelId)
  if (!resolved) throw new Error(`Unknown model for ${p.name}: ${modelId}`)
  // Not in pi-ai's static catalog (e.g. a live-listed model newer than the
  // bundled catalog): clone the largest-context catalog model as a template
  // so the request goes out with the requested id over the same api/baseUrl.
  const model: PiModel<any> = resolved.id === modelId ? resolved : { ...resolved, id: modelId, name: modelId }
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

// Finds a pi-ai catalog model for a subscription provider: the exact id when
// present, otherwise the largest-context catalog model as a stand-in template
// (used both to send live-listed models and to size the compaction threshold).
function resolvePiModel(p: Provider, modelId: string): PiModel<any> | undefined {
  const all = (p.kind === 'claude-sub' ? getModels('anthropic') : getModels('openai-codex')) as PiModel<any>[]
  return (
    all.find((m) => m.id === modelId) ??
    all.reduce<PiModel<any> | undefined>((best, m) => (best && best.contextWindow >= m.contextWindow ? best : m), undefined) ??
    all[all.length - 1]
  )
}

// ---- Context compaction ---------------------------------------------------
// The model is stateless, so every run resends the chat's whole history and
// the cost/quota burn grows without bound. Compaction is the taper: when the
// *sent* context passes a threshold, one extra model call folds the older
// messages into a structured summary, and later runs send [summary + recent
// messages verbatim]. The full original history stays saved on disk and
// visible in the UI — only what is sent changes. (The same idea as Claude
// Code's auto-compaction.)

const COMPACT_KEEP_RECENT = 12 // messages kept verbatim at the tail
const COMPACT_MIN_UNSENT = 16 // never compact with fewer unsummarized messages than this
const COMPACT_WINDOW_FRACTION = 0.55 // of the model's context window
const COMPACT_FALLBACK_THRESHOLD = 60_000 // estimated tokens, when the window is unknown

const SUMMARY_INSTRUCTION = `You are compacting a long conversation so it can continue with a smaller context. Write a structured summary of the conversation segment below that preserves everything needed to continue seamlessly: the user's goals and what they asked for; key facts, names, numbers and decisions; files created or changed and their current state; problems hit and how they were solved; anything the user corrected or said they prefer; and open threads or next steps. Be concrete and specific; do not invent anything; write in tight prose and short lists, no preamble.`

// No tokenizer dependency — the usual chars/4 estimate is close enough for a
// threshold check.
const estTokens = (s: string): number => Math.ceil(s.length / 4)
const clipForSummary = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + `\n…[clipped ${s.length - max} chars]` : s

function msgTokens(m: ChatMessage): number {
  let n = estTokens(typeof m.content === 'string' ? m.content : '')
  for (const tc of m.tool_calls ?? []) n += estTokens(tc.function.name) + estTokens(tc.function.arguments)
  return n
}

// Estimated size of what a run would actually send: system prompt + summary
// (if any) + the messages not yet folded into the summary.
function sentTokens(conv: Conversation, sysText: string): number {
  let n = estTokens(sysText)
  if (conv.summary) n += estTokens(conv.summary)
  const upTo = conv.summaryUpTo ?? 0
  for (let i = upTo; i < conv.messages.length; i++) n += msgTokens(conv.messages[i])
  return n
}

function compactThreshold(p: Provider, modelId: string): number {
  if (p.kind === 'claude-sub' || p.kind === 'chatgpt-sub') {
    const cw = resolvePiModel(p, modelId)?.contextWindow
    if (cw) return Math.floor(cw * COMPACT_WINDOW_FRACTION)
  }
  // HTTP providers carry no model metadata in this codebase — fixed fallback.
  return COMPACT_FALLBACK_THRESHOLD
}

// Index into conv.messages where the kept-verbatim tail begins, or -1 when
// compaction isn't possible/worthwhile. The cut is moved back to a USER
// message so no tool-call/tool-result pair is split across the boundary:
// the tail starts clean and the folded segment ends with complete pairs.
function compactCut(conv: Conversation): number {
  const upTo = conv.summaryUpTo ?? 0
  if (conv.messages.length - upTo < COMPACT_MIN_UNSENT) return -1
  let cut = conv.messages.length - COMPACT_KEEP_RECENT
  while (cut > upTo && conv.messages[cut].role !== 'user') cut--
  return cut > upTo && conv.messages[cut].role === 'user' ? cut : -1
}

function serializeSegment(conv: Conversation, cut: number): string {
  const parts: string[] = []
  // On re-compaction the previous summary is part of the segment, so the new
  // summary folds summary #1 plus the next chunk into one.
  if (conv.summary) parts.push(`SUMMARY OF THE EARLIER PART OF THE CONVERSATION:\n${conv.summary}`)
  for (let i = conv.summaryUpTo ?? 0; i < cut; i++) {
    const m = conv.messages[i]
    let body = typeof m.content === 'string' ? m.content : ''
    if (m.role === 'tool') body = clipForSummary(body, 4_000)
    if (m.tool_calls?.length) {
      const calls = m.tool_calls
        .map((tc) => `[called tool ${tc.function.name} with arguments: ${clipForSummary(tc.function.arguments, 1_000)}]`)
        .join('\n')
      body = body ? `${body}\n${calls}` : calls
    }
    parts.push(`${m.role.toUpperCase()}: ${body || '(no content)'}`)
  }
  return parts.join('\n\n')
}

// The summary rides as a user-role message between the system prompt and the
// verbatim tail. It passes repairOrphans untouched and both converters
// (pi-ai / plain HTTP) accept user messages in this position; Anthropic
// combines it with the following user turn, which is the tail's first message.
const summaryMessage = (summary: string): ChatMessage => ({
  role: 'user',
  content: `Summary of the earlier part of this conversation (older messages were compacted to save context; the full history remains saved):\n\n${summary}`
})

// Attempts one compaction pass over conv. Unless `force` is set, only runs
// when the estimated sent context exceeds the model-dependent threshold.
// Any failure (provider error, empty result, abort) abandons the pass and
// leaves the conversation untouched — compaction must never block a chat.
export async function compactConversation(
  conv: Conversation,
  settings: Settings,
  provider: Provider,
  model: string,
  opts: { force?: boolean; signal?: AbortSignal } = {}
): Promise<{ compacted: boolean; summaryUpTo: number }> {
  const none = { compacted: false, summaryUpTo: conv.summaryUpTo ?? 0 }
  const cut = compactCut(conv)
  if (cut < 0) return none
  if (!opts.force && sentTokens(conv, settings.systemPrompt) <= compactThreshold(provider, model)) return none
  const signal = opts.signal ?? new AbortController().signal
  const input: ChatMessage[] = [
    { role: 'system', content: SUMMARY_INSTRUCTION },
    { role: 'user', content: serializeSegment(conv, cut) }
  ]
  let out: ChatMessage
  try {
    // Same dispatch as a chat run, but no tools — and this call assembles its
    // input directly, so it can never recurse into compaction.
    out =
      provider.kind === 'claude-sub' || provider.kind === 'chatgpt-sub'
        ? await streamSubCompletion(settings, provider, model, input, [], signal, () => {})
        : await streamCompletion(provider, model, input, [], signal, () => {})
  } catch {
    return none
  }
  const text = (typeof out.content === 'string' ? out.content : '').trim()
  if (!text || signal.aborted) return none
  conv.summary = text
  conv.summaryUpTo = cut
  conv.updatedAt = Date.now()
  await saveConv(conv)
  return { compacted: true, summaryUpTo: cut }
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

  // --- Projects: a chat may belong to a project (a folder on disk). For
  // project chats the run works in that folder, and the folder's PROJECT.md
  // memory file is injected into the system prompt. Any project problem
  // (record removed, folder gone) degrades to a normal chat — never a failure.
  const project = conv.projectId ? settings.projects?.find((p) => p.id === conv.projectId) : undefined
  const projectOk = !!project && existsSync(project.path)
  const eff: Settings = projectOk ? { ...settings, workingDir: project!.path } : settings
  let projectBlock = ''
  if (project && projectOk) {
    let mem = ''
    try {
      mem = await readFile(join(project.path, 'PROJECT.md'), 'utf8')
    } catch {}
    if (mem.length > 24_000) mem = mem.slice(0, 24_000) + '\n\n[Note: PROJECT.md was truncated at 24,000 characters.]'
    const intro = `Project: "${project.name}" — you are working in this project's folder.`
    projectBlock = mem.trim()
      ? `${intro} Below is the project's memory file (PROJECT.md), maintained across chats in this project. Keep it updated with your file tools when you learn durable facts, decisions, or context about this project.\n\n--- PROJECT.md ---\n${mem}`
      : `${intro} The project has no PROJECT.md yet — you may create it in the project folder to record durable facts, decisions, and context for future chats in this project.`
  } else if (project) {
    projectBlock = `Note: this chat belongs to the project "${project.name}", but its folder (${project.path}) was not found — you are working in the default directory instead.`
  }

  const sys: ChatMessage = {
    role: 'system',
    content:
      `${eff.systemPrompt}\n\nEnvironment: ${platform()}, home ${homedir()}, working dir ${eff.workingDir}, date ${new Date().toDateString()}.` +
      (projectBlock ? `\n\n${projectBlock}` : '')
  }

  // What a run actually sends: the system prompt, the compaction summary as
  // a stand-in user message (when older messages have been folded into one),
  // then the not-yet-summarized messages with orphaned tool calls repaired.
  // Rebuilt per iteration so tool results from this run join the history.
  const history = (): ChatMessage[] => {
    const out: ChatMessage[] = [sys]
    if (conv.summary) out.push(summaryMessage(conv.summary))
    out.push(...repairOrphans(conv.messages.slice(conv.summaryUpTo ?? 0)))
    return out
  }

  try {
    // Taper before assembling the request: if the sent context has grown
    // past the threshold, fold the older messages into the summary first.
    // A no-op for short chats and on any failure (see compactConversation).
    const c = await compactConversation(conv, eff, provider, model, { signal: ac.signal })
    if (c.compacted) emit({ convId: conv.id, type: 'compacted', summaryUpTo: c.summaryUpTo })

    for (let iter = 0; iter < 25 && !ac.signal.aborted; iter++) {
      const tools = [...builtinTools, ...mcpTools()]
      const isSub = provider.kind === 'claude-sub' || provider.kind === 'chatgpt-sub'
      const msg = isSub
        ? await streamSubCompletion(
            eff,
            provider,
            model,
            history(),
            tools,
            ac.signal,
            (text) => emit({ convId: conv.id, type: 'delta', text })
          )
        : await streamCompletion(
            provider,
            model,
            history(),
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
            let allowed = eff.policy[tool.category] === 'allow'
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
                result = await tool.run(args, { settings: eff, signal: ac.signal })
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
