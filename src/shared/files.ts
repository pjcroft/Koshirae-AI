// Pure document helpers shared by the renderer (paste/drop intake and
// doc chips), the main process (files:extract IPC and send mapping), and
// the Node test harness. No Electron or DOM imports.

export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text'

export const DOC_KINDS: DocKind[] = ['pdf', 'docx', 'xlsx', 'pptx', 'text']

const OOXML_MIMES: Record<string, DocKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
}

const EXT_KINDS: Record<string, DocKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx'
}

// Extensions treated as plain text when the mime doesn't decide it —
// notes, data files, and source code the user might drag in to discuss.
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'html', 'htm',
  'yaml', 'yml', 'ini', 'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'cs', 'sh', 'sql'
])

// Classify a file as a supported document kind from its name and
// declared mime (either may be empty — clipboard/drop metadata is
// unreliable, so both are consulted). Returns null for anything the app
// cannot turn into text: archives, binaries, images, legacy Office
// formats (.doc/.xls/.ppt), and everything else.
export function classifyDoc(name: string, mime: string): DocKind | null {
  const m = (mime || '').toLowerCase()
  if (m === 'application/pdf') return 'pdf'
  if (OOXML_MIMES[m]) return OOXML_MIMES[m]
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase() ?? ''
  if (EXT_KINDS[ext]) return EXT_KINDS[ext]
  if (m.startsWith('text/') || TEXT_EXTS.has(ext)) return 'text'
  return null
}

// Extracted document text is capped before it rides in a conversation:
// enough for a large report, bounded so one attachment can't swamp the
// context window (or the conversation JSON) on its own.
export const MAX_DOC_TEXT = 120_000

export function capDocText(text: string): { text: string; truncated: boolean } {
  const flat = text.replace(/\r\n/g, '\n')
  if (flat.length <= MAX_DOC_TEXT) return { text: flat, truncated: false }
  return {
    text: flat.slice(0, MAX_DOC_TEXT) + `\n\n[Truncated: this file's text exceeded the ${MAX_DOC_TEXT.toLocaleString('en-US')}-character limit.]`,
    truncated: true
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
