// Harness for src/shared/files.ts — document classification, text
// capping, and byte formatting. Run via `npm test` (node --import tsx).
import { MAX_DOC_TEXT, capDocText, classifyDoc, formatBytes } from '../src/shared/files.ts'

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

// classifyDoc — by extension
eq('pdf by ext', classifyDoc('report.pdf', ''), 'pdf')
eq('pdf by ext uppercase', classifyDoc('REPORT.PDF', ''), 'pdf')
eq('docx by ext', classifyDoc('letter.docx', ''), 'docx')
eq('xlsx by ext', classifyDoc('book.xlsx', ''), 'xlsx')
eq('pptx by ext', classifyDoc('deck.pptx', ''), 'pptx')
eq('txt by ext', classifyDoc('notes.txt', ''), 'text')
eq('csv by ext', classifyDoc('data.csv', ''), 'text')
eq('py by ext', classifyDoc('script.py', ''), 'text')
eq('tsx by ext', classifyDoc('app.tsx', ''), 'text')
eq('yaml by ext', classifyDoc('config.yaml', ''), 'text')

// classifyDoc — by mime
eq('pdf by mime', classifyDoc('noext', 'application/pdf'), 'pdf')
eq('docx by mime', classifyDoc('noext', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx')
eq('xlsx by mime', classifyDoc('noext', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx')
eq('pptx by mime', classifyDoc('noext', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx')
eq('text by text/* mime', classifyDoc('README', 'text/plain'), 'text')
eq('csv by text mime', classifyDoc('data', 'text/csv'), 'text')

// classifyDoc — unsupported
eq('image is not a doc', classifyDoc('photo.png', 'image/png'), null)
eq('zip unsupported', classifyDoc('archive.zip', 'application/zip'), null)
eq('legacy .doc unsupported', classifyDoc('old.doc', 'application/msword'), null)
eq('empty name and mime', classifyDoc('', ''), null)

// capDocText
{
  const r = capDocText('hello')
  eq('short passthrough', r.text, 'hello')
  eq('short not truncated', r.truncated, false)
}
{
  const r = capDocText('a\r\nb\r\nc')
  eq('crlf collapsed', r.text, 'a\nb\nc')
  eq('crlf not truncated', r.truncated, false)
}
{
  const r = capDocText('x'.repeat(MAX_DOC_TEXT + 5000))
  eq('long is truncated', r.truncated, true)
  ok('long keeps the head', r.text.startsWith('x'.repeat(1000)))
  ok(
    'long ends with the marker',
    r.text.endsWith("[Truncated: this file's text exceeded the 120,000-character limit.]")
  )
  eq('long total length', r.text.length, MAX_DOC_TEXT + '\n\n[Truncated: this file\'s text exceeded the 120,000-character limit.]'.length)
}

// formatBytes
eq('bytes', formatBytes(512), '512 B')
eq('kb', formatBytes(2048), '2.0 KB')
eq('kb fraction', formatBytes(1536), '1.5 KB')
eq('mb', formatBytes(5 * 1024 * 1024), '5.0 MB')

for (const f of failures) console.error('FAIL:', f)
console.log(`files.harness: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) process.exit(1)
