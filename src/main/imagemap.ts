import type { ChatMessage } from '@shared/types'

// Image attachment mapping for the two provider transports. ChatMessage
// stores attachments inline ({ mime, dataBase64 }); each API wants its own
// shape. These functions are pure (no Electron imports) so the mapping can
// be exercised directly by a Node test harness.

// ---- OpenAI-compatible HTTP providers (OpenRouter / OpenAI / Ollama / LM
// Studio, and Anthropic models reached through OpenRouter) ----

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

// The wire form of one message. Messages without attachments pass through
// untouched (same object); a user message with attachments becomes a
// content-parts array and the inline attachments field is dropped (the
// APIs don't know it, and the base64 already rides in the image_url data
// URLs).
export function mapOpenAIMessage(m: ChatMessage): unknown {
  if (m.role !== 'user' || !m.attachments?.length) return m
  const text = typeof m.content === 'string' ? m.content : ''
  const parts: OpenAIContentPart[] = []
  if (text) parts.push({ type: 'text', text })
  for (const a of m.attachments)
    parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.dataBase64}` } })
  const { attachments: _attachments, ...rest } = m
  return { ...rest, content: parts }
}

export function mapOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map(mapOpenAIMessage)
}

// ---- Subscription providers via pi-ai (Claude Pro/Max, ChatGPT Plus/Pro —
// this is also the only Anthropic path; there is no separate Anthropic
// HTTP transport in the app) ----

export type PiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

// pi-ai user content for one message: the text part first, then one image
// part per attachment. With no attachments this is exactly the single text
// part the converter has always produced.
export function piUserContent(m: ChatMessage): PiContentPart[] {
  const parts: PiContentPart[] = [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }]
  for (const a of m.attachments ?? []) parts.push({ type: 'image', data: a.dataBase64, mimeType: a.mime })
  return parts
}
