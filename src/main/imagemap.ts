import type { ChatMessage, DocAttachment } from '@shared/types'
import { formatBytes } from '@shared/files'

// Attachment mapping for the two provider transports. ChatMessage stores
// image attachments inline ({ mime, dataBase64 }) and document
// attachments as extracted text (plus, for PDFs ≤ 10 MB, the original
// bytes); each API wants its own shape. These functions are pure (no
// Electron imports) so the mapping can be exercised directly by a Node
// test harness.

// The text block a document becomes when it is inlined into a message:
// a header naming the file, then its extracted text. Used by every
// transport except a native-PDF file part (OpenRouter / OpenAI only).
export function docTextBlock(d: DocAttachment): string {
  const pages = d.pages ? `, ${d.pages} pages` : ''
  return `\n\n--- Attached file: ${d.name} (${d.kind.toUpperCase()}, ${formatBytes(d.size)}${pages}) ---\n${d.text}`
}

// ---- OpenAI-compatible HTTP providers (OpenRouter / OpenAI / Ollama / LM
// Studio, and Anthropic models reached through OpenRouter) ----

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

// Providers whose chat API accepts a native PDF file part. Everywhere
// else (and for every non-PDF document) the extracted text is inlined.
const NATIVE_PDF_PROVIDERS = new Set(['openrouter', 'openai'])

// The wire form of one message. Messages without attachments pass through
// untouched (same object); a user message with attachments becomes a
// content-parts array and the inline attachments/files fields are dropped
// (the APIs don't know them, and the payload already rides in the parts).
export function mapOpenAIMessage(m: ChatMessage, providerId?: string): unknown {
  if (m.role !== 'user' || (!m.attachments?.length && !m.files?.length)) return m
  let text = typeof m.content === 'string' ? m.content : ''
  const parts: OpenAIContentPart[] = []
  for (const a of m.attachments ?? [])
    parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.dataBase64}` } })
  for (const d of m.files ?? []) {
    if (d.kind === 'pdf' && d.dataBase64 && providerId && NATIVE_PDF_PROVIDERS.has(providerId)) {
      parts.push({
        type: 'file',
        file: { filename: d.name, file_data: `data:application/pdf;base64,${d.dataBase64}` }
      })
    } else {
      text += docTextBlock(d)
    }
  }
  if (text) parts.unshift({ type: 'text', text })
  const { attachments: _attachments, files: _files, ...rest } = m
  return { ...rest, content: parts }
}

export function mapOpenAIMessages(messages: ChatMessage[], providerId?: string): unknown[] {
  return messages.map((m) => mapOpenAIMessage(m, providerId))
}

// ---- Subscription providers via pi-ai (Claude Pro/Max, ChatGPT Plus/Pro —
// this is also the only Anthropic path; there is no separate Anthropic
// HTTP transport in the app) ----

export type PiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

// pi-ai user content for one message: the text part first (documents
// inlined into it — pi-ai has no document part), then one image part per
// attachment. With no attachments this is exactly the single text part
// the converter has always produced.
export function piUserContent(m: ChatMessage): PiContentPart[] {
  let text = typeof m.content === 'string' ? m.content : ''
  for (const d of m.files ?? []) text += docTextBlock(d)
  const parts: PiContentPart[] = [{ type: 'text', text }]
  for (const a of m.attachments ?? []) parts.push({ type: 'image', data: a.dataBase64, mimeType: a.mime })
  return parts
}
