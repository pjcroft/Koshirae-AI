// Wiring checks for the 0.9.4 UI fixes (App.tsx / styles.css source level):
// the floating working pill, the light-gray tool cards, plain-text streaming,
// and the calmer auto-scroll. The renderer has no DOM test rig; these assert
// the shipped pieces are actually present and connected.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = readFileSync(join(root, 'src/renderer/App.tsx'), 'utf8')
const css = readFileSync(join(root, 'src/renderer/styles.css'), 'utf8')

let pass = 0, fail = 0
const check = (name, ok) => { if (ok) { pass++; console.log('  ok -', name) } else { fail++; console.log('  FAIL -', name) } }

check('working pill renders while busy', app.includes('{busy && (') && app.includes('className="workpill"'))
check('pill label derives from approvals / running tool / streaming', app.includes("pillState === 'wait'") && app.includes('Running ${runningTool!.function.name}') && app.includes("'Answering'") && app.includes("'Thinking'"))
check('pill elapsed clock ticks while busy', app.includes('setBusyTick') && app.includes('busySince'))
check('pill styles ship with a pulsing dot', css.includes('.workpill{') && css.includes('@keyframes wpulse'))
check('busy timer effect runs before the settings early-return (hook order)', app.indexOf('setInterval(() => setBusyTick') > -1 && app.indexOf('setInterval(() => setBusyTick') < app.indexOf('if (!settings) return null'))
check('streaming renders as plain text, not markdown', app.includes('<div className="streamtext">{streaming}</div>') && css.includes('.streamtext{white-space:pre-wrap'))
check('auto-scroll no longer fires per streamed token', !app.includes('[conv?.messages.length, streaming, approvals.length]') && app.includes('chatRef'))
check('tool cards are light gray with dark text', css.includes('.tool{background:#e9edf2') && css.includes('.tool pre{background:#f7f9fb;color:#111827}'))

console.log(`\nuifix harness: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
