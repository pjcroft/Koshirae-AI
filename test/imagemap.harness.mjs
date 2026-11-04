// Harness for src/main/imagemap.ts — attachment → wire mapping for the
// OpenAI-compatible and pi-ai transports, documents included.
import { docTextBlock, mapOpenAIMessage, mapOpenAIMessages, piUserContent } from '../src/main/imagemap.ts'

let passed = 0
const failures = []
function eq(name, actual, expected) {
  if (actual === expected) passed++
  else failures.push(`${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}
function ok(name, cond) {
  if (cond) passed++
  else failures.push(name)
}

const pdfDoc = {
  name: 'spec.pdf',
  mime: 'application/pdf',
  kind: 'pdf',
  size: 2048,
  text: 'PDF BODY TEXT',
  pages: 3,
  dataBase64: 'QUJD'
}
const pdfNoBytes = {
  name: 'big.pdf',
  mime: 'application/pdf',
  kind: 'pdf',
  size: 40 * 1024 * 1024,
  text: 'BIG PDF TEXT',
  pages: 9
}
const docxDoc = {
  name: 'memo.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  kind: 'docx',
  size: 1024,
  text: 'MEMO BODY'
}

// docTextBlock format
eq(
  'block format with pages',
  docTextBlock(pdfDoc),
  '\n\n--- Attached file: spec.pdf (PDF, 2.0 KB, 3 pages) ---\nPDF BODY TEXT'
)
eq('block format without pages', docTextBlock(docxDoc), '\n\n--- Attached file: memo.docx (DOCX, 1.0 KB) ---\nMEMO BODY')

// Native PDF part on openrouter
{
  const out = mapOpenAIMessage({ role: 'user', content: 'Read this', files: [pdfDoc] }, 'openrouter')
  const parts = out.content
  ok('openrouter pdf: content is parts', Array.isArray(parts))
  eq('openrouter pdf: first part is the text', parts[0].type, 'text')
  eq('openrouter pdf: text untouched', parts[0].text, 'Read this')
  const filePart = parts.find((p) => p.type === 'file')
  ok('openrouter pdf: file part present', !!filePart)
  eq('openrouter pdf: filename', filePart?.file.filename, 'spec.pdf')
  eq('openrouter pdf: file_data', filePart?.file.file_data, 'data:application/pdf;base64,QUJD')
  ok('openrouter pdf: body not inlined', !JSON.stringify(parts).includes('PDF BODY TEXT'))
  ok('openrouter pdf: files field stripped', !('files' in out))
}
// Native PDF part on openai
{
  const out = mapOpenAIMessage({ role: 'user', content: '', files: [pdfDoc] }, 'openai')
  eq('openai pdf: single file part', out.content.length, 1)
  eq('openai pdf: part type', out.content[0].type, 'file')
}
// Same PDF inlined on lmstudio
{
  const out = mapOpenAIMessage({ role: 'user', content: 'Read this', files: [pdfDoc] }, 'lmstudio')
  const parts = out.content
  ok('lmstudio pdf: no file part', !parts.some((p) => p.type === 'file'))
  eq('lmstudio pdf: single text part', parts.length, 1)
  ok('lmstudio pdf: header present', parts[0].text.includes('--- Attached file: spec.pdf (PDF, 2.0 KB, 3 pages) ---'))
  ok('lmstudio pdf: body inlined', parts[0].text.includes('PDF BODY TEXT'))
  ok('lmstudio pdf: user text kept', parts[0].text.startsWith('Read this'))
}
// PDF without bytes inlines even on openrouter
{
  const out = mapOpenAIMessage({ role: 'user', content: '', files: [pdfNoBytes] }, 'openrouter')
  ok('openrouter big pdf: no file part', !out.content.some((p) => p.type === 'file'))
  ok('openrouter big pdf: body inlined', out.content[0].text.includes('BIG PDF TEXT'))
  ok('openrouter big pdf: pages in header', out.content[0].text.includes(', 9 pages)'))
}
// No providerId → inline
{
  const out = mapOpenAIMessage({ role: 'user', content: '', files: [pdfDoc] })
  ok('no provider: no file part', !out.content.some((p) => p.type === 'file'))
}
// DOCX inlines on both flavors
for (const pid of ['openrouter', 'lmstudio']) {
  const out = mapOpenAIMessage({ role: 'user', content: '', files: [docxDoc] }, pid)
  ok(`${pid} docx: no file part`, !out.content.some((p) => p.type === 'file'))
  eq(`${pid} docx: one text part`, out.content.length, 1)
  ok(`${pid} docx: body inlined`, out.content[0].text.includes('MEMO BODY'))
}
// Doc-only message maps to well-formed parts
{
  const out = mapOpenAIMessage({ role: 'user', content: '', files: [docxDoc] }, 'openrouter')
  ok('doc-only: content array', Array.isArray(out.content) && out.content.length === 1)
  eq('doc-only: part type', out.content[0].type, 'text')
}
// Images and docs together: text, image, then docs
{
  const img = { mime: 'image/png', dataBase64: 'AAAA' }
  const out = mapOpenAIMessage({ role: 'user', content: 'look', attachments: [img], files: [docxDoc] }, 'ollama')
  eq('mixed: part count', out.content.length, 2)
  eq('mixed: text first with doc inlined', out.content[0].type, 'text')
  ok('mixed: doc in text', out.content[0].text.includes('MEMO BODY'))
  eq('mixed: image part', out.content[1].type, 'image_url')
  eq('mixed: image url', out.content[1].image_url.url, 'data:image/png;base64,AAAA')
}
// Passthrough: no attachments/files → same object
{
  const m = { role: 'user', content: 'hello' }
  ok('plain message passes through by reference', mapOpenAIMessage(m, 'openrouter') === m)
  const a = { role: 'assistant', content: 'hi' }
  ok('assistant passes through', mapOpenAIMessage(a) === a)
}
// The plural mapper threads providerId
{
  const out = mapOpenAIMessages([{ role: 'user', content: '', files: [pdfDoc] }], 'openrouter')
  eq('plural: file part present', out[0].content[0].type, 'file')
}
// pi mapping: docs inline into the text part; images stay image parts
{
  const parts = piUserContent({
    role: 'user',
    content: 'Hi',
    files: [docxDoc],
    attachments: [{ mime: 'image/png', dataBase64: 'AAAA' }]
  })
  eq('pi: part count', parts.length, 2)
  eq('pi: text first', parts[0].type, 'text')
  ok('pi: doc inlined', parts[0].text.includes('MEMO BODY'))
  ok('pi: user text kept', parts[0].text.startsWith('Hi'))
  eq('pi: image part type', parts[1].type, 'image')
  eq('pi: image data', parts[1].data, 'AAAA')
  eq('pi: image mime', parts[1].mimeType, 'image/png')
}
{
  const parts = piUserContent({ role: 'user', content: '', files: [pdfDoc] })
  eq('pi pdf: single part', parts.length, 1)
  ok('pi pdf: body inlined despite bytes', parts[0].text.includes('PDF BODY TEXT'))
}

for (const f of failures) console.error('FAIL:', f)
console.log(`imagemap.harness: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) process.exit(1)
