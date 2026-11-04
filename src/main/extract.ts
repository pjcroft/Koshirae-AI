import pdfParse from 'pdf-parse/lib/pdf-parse.js'
import * as mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import AdmZip from 'adm-zip'
import { DOC_KINDS, capDocText, formatBytes, type DocKind } from '@shared/files'
import type { ExtractFileResult } from '@shared/types'

// files:extract — turn an attached document into the text the model will
// read. Everything runs locally in the main process; no part of the file
// leaves the machine here. Failures are returned as { ok: false, error }
// (or thrown with a user-readable message) — never a stack trace.

// Decoded-size ceiling for one extraction request. The renderer caps the
// native-PDF passthrough at 10 MB; this leaves headroom while keeping a
// runaway clipboard/drop from being decoded in full.
export const MAX_DOC_BYTES = 12 * 1024 * 1024

const unescapeXml = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

// PowerPoint decks are zip packages of slide XML; the visible text lives
// in <a:t> runs. Slides are ordered by their numeric suffix (slide2
// before slide10), one section per slide.
function extractPptx(buf: Buffer): { text: string; pages: number } {
  const zip = new AdmZip(buf)
  const slides = zip
    .getEntries()
    .map((e) => ({ entry: e, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.entryName) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
  const sections: string[] = []
  for (const { entry, m } of slides) {
    const xml = entry.getData().toString('utf8')
    const runs = Array.from(xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)).map((r) => unescapeXml(r[1]))
    sections.push(`## Slide ${m![1]}\n${runs.join(' ')}`)
  }
  return { text: sections.join('\n\n'), pages: slides.length }
}

function extractXlsx(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const sections: string[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (ws) sections.push(`## Sheet: ${name}\n${XLSX.utils.sheet_to_csv(ws)}`)
  }
  return sections.join('\n\n')
}

// Extract one document's text. Throws an Error with a user-readable
// message when the file has no readable text at all.
export async function extractDocument(
  kind: DocKind,
  name: string,
  buf: Buffer
): Promise<{ text: string; pages?: number; truncated: boolean }> {
  let raw = ''
  let pages: number | undefined
  switch (kind) {
    case 'pdf': {
      // pdf.js (inside pdf-parse) reads the buffer's underlying bytes
      // without honouring a view offset, and Node Buffers are routinely
      // slices of a shared pool — a small PDF handed over as-is lands
      // its xref offsets mid-file and dies with "bad XRef entry". Pass
      // an exact, unpooled copy.
      const bytes = new Uint8Array(buf.length)
      bytes.set(buf)
      const data = await pdfParse(bytes)
      raw = data.text
      pages = data.numpages
      break
    }
    case 'docx': {
      const r = await mammoth.extractRawText({ buffer: buf })
      raw = r.value
      break
    }
    case 'xlsx':
      raw = extractXlsx(buf)
      break
    case 'pptx': {
      const r = extractPptx(buf)
      raw = r.text
      pages = r.pages
      break
    }
    case 'text':
      raw = buf.toString('utf8')
      break
  }
  const capped = capDocText(raw)
  if (!capped.text.trim()) {
    throw new Error(
      kind === 'pdf'
        ? 'That PDF has no readable text layer (it looks like scanned images).'
        : `No readable text found in ${name}.`
    )
  }
  return { text: capped.text, ...(pages ? { pages } : {}), truncated: capped.truncated }
}

// The files:extract IPC payload, validated the same way images:normalize
// validates its input: untrusted shape in, a result object out.
export async function extractFilePayload(a: {
  name?: unknown
  kind?: unknown
  dataBase64?: unknown
}): Promise<ExtractFileResult> {
  const name = typeof a?.name === 'string' && a.name ? a.name : 'file'
  if (!DOC_KINDS.includes(a?.kind as DocKind)) return { ok: false, error: 'Unsupported file type.' }
  if (typeof a?.dataBase64 !== 'string' || !a.dataBase64)
    return { ok: false, error: 'No file data was received.' }
  const buf = Buffer.from(a.dataBase64, 'base64')
  if (buf.length > MAX_DOC_BYTES)
    return {
      ok: false,
      error: `That file is too large to read (${formatBytes(buf.length)}; the limit is ${MAX_DOC_BYTES / 1024 / 1024} MB).`
    }
  try {
    const r = await extractDocument(a.kind as DocKind, name, buf)
    return {
      ok: true,
      text: r.text,
      ...(r.pages ? { pages: r.pages } : {}),
      ...(r.truncated ? { truncated: true } : {})
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
