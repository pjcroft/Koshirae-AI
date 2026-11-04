// Harness for src/shared/imaging.ts — regression cover for the image
// flow that 0.9.0's unified intake must leave unchanged: magic-byte
// sniffing and the paste/drop batch dedupe decisions.
import { dedupeDecisions, hashBytes, sniffImageMime } from '../src/shared/imaging.ts'

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

eq('sniff png', sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), 'image/png')
eq('sniff jpeg', sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'image/jpeg')
eq('sniff tiff LE', sniffImageMime(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08])), 'image/tiff')
eq('sniff non-image', sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null) // "%PDF"
eq('sniff empty', sniffImageMime(new Uint8Array([])), null)

const a = { hash: 'h1', width: 800, height: 600 }
const aTwin = { hash: 'h2', width: 800, height: 600 } // same picture, other encoding
const aSame = { hash: 'h1', width: 800, height: 600 } // byte-identical repeat
const b = { hash: 'h3', width: 800, height: 600 } // different file, same dimensions

eq('paste: format twin dropped by dims', JSON.stringify(dedupeDecisions([a, aTwin], 'paste')), JSON.stringify(['keep', 'dup-dims']))
eq('drop: same-size files both kept', JSON.stringify(dedupeDecisions([a, b], 'drop')), JSON.stringify(['keep', 'keep']))
eq('paste: byte repeat dropped by hash', JSON.stringify(dedupeDecisions([a, aSame], 'paste')), JSON.stringify(['keep', 'dup-hash']))
eq('drop: byte repeat dropped by hash', JSON.stringify(dedupeDecisions([a, aSame], 'drop')), JSON.stringify(['keep', 'dup-hash']))
ok('hash differs for different bytes', hashBytes(new Uint8Array([1, 2, 3])) !== hashBytes(new Uint8Array([1, 2, 4])))

for (const f of failures) console.error('FAIL:', f)
console.log(`imaging.harness: ${passed}/${passed + failures.length} checks passed`)
if (failures.length) process.exit(1)
