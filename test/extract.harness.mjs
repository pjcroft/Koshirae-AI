// Harness for src/main/extract.ts — builds minimal real fixtures with
// python3 + zipfile (hand-rolled OOXML packages and a hand-written PDF),
// then runs the REAL extractDocument over each.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractDocument } from '../src/main/extract.ts'

let passed = 0
const failures = []
function ok(name, cond) {
  if (cond) passed++
  else failures.push(name)
}
async function acheck(name, fn) {
  try {
    await fn()
    passed++
  } catch (e) {
    failures.push(`${name}: ${e?.message ?? e}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const dir = mkdtempSync(join(tmpdir(), 'koshirae-extract-'))
const PY = String.raw`
import sys, zipfile
out = sys.argv[1]

document_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Alpha paragraph one</w:t></w:r></w:p>
    <w:p><w:r><w:t>Fish &amp; Chips tonight</w:t></w:r></w:p>
  </w:body>
</w:document>'''
ct_docx = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
with zipfile.ZipFile(out + '/fixture.docx', 'w') as z:
    z.writestr('[Content_Types].xml', ct_docx)
    z.writestr('word/document.xml', document_xml)

workbook_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>'''
rels_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>'''
shared = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>Part</t></si>
  <si><t>Qty</t></si>
  <si><t>Bracket</t></si>
  <si><t>Remember the gasket</t></si>
</sst>'''
sheet1 = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
  </sheetData>
</worksheet>'''
sheet2 = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>3</v></c></row>
  </sheetData>
</worksheet>'''
ct_xlsx = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>'''
with zipfile.ZipFile(out + '/fixture.xlsx', 'w') as z:
    z.writestr('[Content_Types].xml', ct_xlsx)
    z.writestr('xl/workbook.xml', workbook_xml)
    z.writestr('xl/_rels/workbook.xml.rels', rels_xml)
    z.writestr('xl/sharedStrings.xml', shared)
    z.writestr('xl/worksheets/sheet1.xml', sheet1)
    z.writestr('xl/worksheets/sheet2.xml', sheet2)

slide1 = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly Results</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>'''
slide2 = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Q&amp;A session</a:t></a:r></a:p>
    <a:p><a:r><a:t>Wrap up</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>'''
with zipfile.ZipFile(out + '/fixture.pptx', 'w') as z:
    z.writestr('ppt/slides/slide1.xml', slide1)
    z.writestr('ppt/slides/slide2.xml', slide2)

def make_pdf(stream):
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    outb = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(outb))
        outb += ("%d 0 obj\n" % i).encode() + body + b"\nendobj\n"
    xref = len(outb)
    outb += ("xref\n0 %d\n" % (len(objs) + 1)).encode()
    outb += b"0000000000 65535 f \n"
    for off in offsets:
        outb += ("%010d 00000 n \n" % off).encode()
    outb += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)).encode()
    return bytes(outb)

with open(out + '/fixture.pdf', 'wb') as f:
    f.write(make_pdf(b"BT /F1 24 Tf 100 700 Td (Koshirae Extract Fixture) Tj ET"))
with open(out + '/empty.pdf', 'wb') as f:
    f.write(make_pdf(b""))
print('fixtures written')
`
const genPath = join(dir, 'gen.py')
writeFileSync(genPath, PY)
execFileSync('python3', [genPath, dir], { stdio: 'pipe' })

const read = (n) => readFileSync(join(dir, n))

await acheck('docx: paragraphs extracted in order, & unescaped', async () => {
  const r = await extractDocument('docx', 'fixture.docx', read('fixture.docx'))
  assert(r.text.includes('Alpha paragraph one'), 'missing first paragraph')
  assert(r.text.includes('Fish & Chips tonight'), 'missing unescaped & paragraph')
  assert(r.text.indexOf('Alpha paragraph one') < r.text.indexOf('Fish & Chips'), 'paragraph order wrong')
})

await acheck('xlsx: sheets in order with CSV values', async () => {
  const r = await extractDocument('xlsx', 'fixture.xlsx', read('fixture.xlsx'))
  assert(r.text.includes('## Sheet: Data'), 'missing Data sheet header')
  assert(r.text.includes('## Sheet: Notes'), 'missing Notes sheet header')
  assert(r.text.includes('Part,Qty'), 'missing header row CSV')
  assert(r.text.includes('Bracket,42'), 'missing value row CSV')
  assert(r.text.includes('Remember the gasket'), 'missing Notes content')
  assert(r.text.indexOf('## Sheet: Data') < r.text.indexOf('## Sheet: Notes'), 'sheet order wrong')
})

await acheck('pptx: slides in order, runs unescaped, pages=2', async () => {
  const r = await extractDocument('pptx', 'fixture.pptx', read('fixture.pptx'))
  assert(r.pages === 2, `pages=${r.pages}`)
  assert(r.text.includes('## Slide 1'), 'missing Slide 1 header')
  assert(r.text.includes('## Slide 2'), 'missing Slide 2 header')
  assert(r.text.includes('Quarterly Results'), 'missing slide 1 text')
  assert(r.text.includes('Q&A session'), 'missing unescaped slide 2 text')
  assert(r.text.includes('Wrap up'), 'missing second run')
  assert(r.text.indexOf('Quarterly Results') < r.text.indexOf('Q&A session'), 'slide order wrong')
})

await acheck('pdf: text extracted, pages=1', async () => {
  const r = await extractDocument('pdf', 'fixture.pdf', read('fixture.pdf'))
  assert(r.pages === 1, `pages=${r.pages}`)
  assert(r.text.includes('Koshirae Extract Fixture'), 'missing PDF text')
})

await acheck('pdf: no text layer rejects with the scanned-images error', async () => {
  let msg = ''
  try {
    await extractDocument('pdf', 'empty.pdf', read('empty.pdf'))
  } catch (e) {
    msg = e?.message ?? ''
  }
  assert(/no readable text layer/.test(msg), `unexpected error: ${msg}`)
})

await acheck('text: plain buffer passes through', async () => {
  const r = await extractDocument('text', 'note.txt', Buffer.from('plain hello world'))
  assert(r.text === 'plain hello world', `got ${JSON.stringify(r.text)}`)
  assert(r.truncated === false, 'should not be truncated')
})

await acheck('text: empty buffer rejects naming the file', async () => {
  let msg = ''
  try {
    await extractDocument('text', 'blank.txt', Buffer.from('   \n  '))
  } catch (e) {
    msg = e?.message ?? ''
  }
  assert(msg === 'No readable text found in blank.txt.', `unexpected error: ${msg}`)
})

for (const f of failures) console.error('FAIL:', f)
console.log(`extract.harness: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) process.exit(1)
