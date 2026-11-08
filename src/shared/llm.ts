// Portable (Node + browser) OpenAI-compatible transport, shared by the
// desktop main process and the Android build. No Electron/Node imports.
import type { ChatMessage, Provider, ToolCall } from './types'
import { mapOpenAIMessages } from './openai-map'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const providerHeaders = (p: Provider): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`
  if (p.baseUrl.includes('openrouter.ai')) {
    h['HTTP-Referer'] = 'https://pjcroft.ddnsfree.com'
    h['X-Title'] = 'Koshirae AI'
  }
  return h
}
export const baseUrl = (p: Provider) => p.baseUrl.replace(/\/+$/, '')

export async function listHttpModels(p: Provider): Promise<string[]> {
  const r = await fetch(baseUrl(p) + '/models', { headers: providerHeaders(p) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j: any = await r.json()
  return (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean).sort()
}

export async function streamCompletion(
  p: Provider,
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
  onDelta: (t: string) => void,
  maxTokens?: number
): Promise<ChatMessage> {
  // Attachments ride inline on ChatMessage; the wire format wants content
  // parts, so map here (attachment-free messages pass through unchanged).
  // The provider id decides whether a PDF goes as a native file part.
  const body: any = { model, messages: mapOpenAIMessages(messages, p.id), stream: true }
  if (maxTokens) body.max_tokens = maxTokens
  if (tools.length)
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
  let content = ''
  const calls: ToolCall[] = []
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
  const r = await fetch(baseUrl(p) + '/chat/completions', {
    method: 'POST',
    headers: providerHeaders(p),
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
  const real = calls.filter(Boolean).map((c) => ({ ...c, id: c.id || crypto.randomUUID().slice(0, 12) }))
  const msg: ChatMessage = { role: 'assistant', content: content || null }
  if (real.length && !signal.aborted) msg.tool_calls = real
  return msg
}

export function repairOrphans(msgs: ChatMessage[]): ChatMessage[] {
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

