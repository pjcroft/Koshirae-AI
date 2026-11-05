// Harness for src/shared/sysprompt.ts — the default system prompt and the
// load-time upgrade that swaps an untouched legacy default for the current
// one (customised prompts must pass through unchanged).
import { SYSTEM_PROMPT, upgradeSystemPromptText } from '../src/shared/sysprompt.ts'

let passed = 0
const failures = []
function eq(name, actual, expected) {
  if (actual === expected) passed++
  else failures.push(`${name}: mismatch`)
}
function ok(name, cond) {
  if (cond) passed++
  else failures.push(name)
}

const LEGACY =
  'You are Koshirae AI, a capable assistant running on the user\'s computer with tools for local files, shell commands, SSH, SMB shares, and Tailscale. Use tools when they help; be concise and careful with anything destructive.'

eq('legacy default upgrades', upgradeSystemPromptText(LEGACY), SYSTEM_PROMPT)
eq('current default unchanged', upgradeSystemPromptText(SYSTEM_PROMPT), SYSTEM_PROMPT)
eq('custom prompt untouched', upgradeSystemPromptText('You are a pirate assistant.'), 'You are a pirate assistant.')
eq('empty prompt untouched', upgradeSystemPromptText(''), '')
ok('prompt covers attachments', SYSTEM_PROMPT.includes('Attachments are handled by the app'))
ok('prompt covers vision caveat', SYSTEM_PROMPT.includes('text-only model'))
ok('prompt keeps the tools line', SYSTEM_PROMPT.includes('SSH, SMB shares, Tailscale hosts, and web search'))

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`sysprompt.harness: ${passed}/${passed} checks passed`)
