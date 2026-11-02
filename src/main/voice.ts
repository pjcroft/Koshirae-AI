import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, statSync } from 'fs'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import type { Settings, VoiceResult, VoiceStatus } from '@shared/types'
import { oneShotCompletion } from './agent'

// Voice dictation is fully on-device: whisper.cpp (whisper-cli) transcribes,
// and an optional one-shot model pass cleans the text up. The Whisper model
// is far too big to ship in the app, so it is downloaded once into
// <userData>/voice/ from the Whisper project's Hugging Face repo.

export const VOICE_MODEL_FILE = 'ggml-large-v3-turbo.bin'
export const VOICE_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${VOICE_MODEL_FILE}`
const TRANSCRIBE_TIMEOUT_MS = 120_000

export const voiceDir = () => join(app.getPath('userData'), 'voice')
export const voiceModelPath = () => join(voiceDir(), VOICE_MODEL_FILE)

// Engine resolution order: (a) a binary bundled with the app
// (extraResources → <resources>/whisper/whisper-cli), (b) a Homebrew
// install. Never throws — voiceStatus() reports what was found and
// transcribe() turns "neither" into a readable error.
export function resolveEngine(): string | null {
  const candidates = [
    join(process.resourcesPath, 'whisper', 'whisper-cli'),
    '/opt/homebrew/bin/whisper-cli', // Homebrew on Apple Silicon
    '/usr/local/bin/whisper-cli' // Homebrew on Intel
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export function voiceStatus(): VoiceStatus {
  const engine = resolveEngine()
  let modelPresent = false
  let modelSize: number | undefined
  try {
    const st = statSync(voiceModelPath())
    if (st.isFile()) {
      modelPresent = true
      modelSize = st.size
    }
  } catch {}
  return { engineFound: !!engine, enginePath: engine ?? undefined, modelPresent, modelSize }
}

const ENGINE_MISSING =
  'Whisper engine not found. Voice dictation needs the whisper-cli engine — install it with "brew install whisper-cpp", then try again.'
const MODEL_MISSING =
  'The Whisper model (large-v3-turbo, ~1.6 GB) has not been downloaded yet. Open Settings → Voice dictation and click "Download model".'

function runEngine(engine: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr = (stderr + String(d)).slice(-4000)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`whisper-cli timed out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s`))
    }, TRANSCRIBE_TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

// Transcribes 16 kHz mono WAV bytes with whisper-cli. All failure modes are
// returned as { ok: false, error } — this never throws.
export async function transcribe(wav: Uint8Array): Promise<VoiceResult> {
  const engine = resolveEngine()
  if (!engine) return { ok: false, code: 'engine-missing', error: ENGINE_MISSING }
  if (!voiceStatus().modelPresent) return { ok: false, code: 'model-missing', error: MODEL_MISSING }
  const base = join(tmpdir(), `koshirae-voice-${randomUUID()}`)
  const wavPath = base + '.wav'
  const txtPath = base + '.txt'
  try {
    await writeFile(wavPath, wav)
    // The exact invocation the feature is verified against (see the JFK
    // sample check): plain-text output next to a temp base name, English.
    const args = ['-m', voiceModelPath(), '-f', wavPath, '-l', 'en', '-otxt', '-of', base]
    const res = await runEngine(engine, args)
    if (res.code !== 0)
      return { ok: false, error: `Whisper failed (exit ${res.code}): ${res.stderr.trim().slice(-400) || 'no output'}` }
    const text = (await readFile(txtPath, 'utf8')).trim()
    if (!text) return { ok: false, error: 'Whisper heard nothing — no text came back. Try again a little closer to the mic.' }
    return { ok: true, text }
  } catch (e: any) {
    return { ok: false, error: `Transcription failed: ${e?.message ?? e}` }
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
    await rm(txtPath, { force: true }).catch(() => {})
  }
}

let downloading = false

// Downloads the Whisper model into <userData>/voice/, streaming progress to
// the renderer as voice:model-progress events. Writes to a .part file and
// renames on success, so an interrupted download never looks complete.
export async function downloadModel(win: BrowserWindow): Promise<{ ok: boolean; error?: string }> {
  if (downloading) return { ok: false, error: 'A model download is already in progress.' }
  downloading = true
  const part = voiceModelPath() + '.part'
  try {
    await mkdir(voiceDir(), { recursive: true })
    const r = await fetch(VOICE_MODEL_URL, { redirect: 'follow' })
    if (!r.ok || !r.body) return { ok: false, error: `Model download failed: HTTP ${r.status}` }
    const total = Number(r.headers.get('content-length') ?? 0)
    const out = createWriteStream(part)
    let streamErr: Error | null = null
    out.on('error', (e) => {
      streamErr = e
    })
    const reader = r.body.getReader()
    let got = 0
    let lastPct = -1
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (streamErr) throw streamErr
      got += value.byteLength
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res))
      if (total > 0) {
        const pct = Math.floor((got / total) * 100)
        if (pct !== lastPct) {
          lastPct = pct
          if (!win.isDestroyed()) win.webContents.send('voice:model-progress', { pct })
        }
      }
    }
    await new Promise<void>((res, rej) => out.end(() => (streamErr ? rej(streamErr) : res())))
    await rename(part, voiceModelPath())
    if (!win.isDestroyed()) win.webContents.send('voice:model-progress', { pct: 100 })
    return { ok: true }
  } catch (e: any) {
    await rm(part, { force: true }).catch(() => {})
    return { ok: false, error: `Model download failed: ${e?.message ?? e}` }
  } finally {
    downloading = false
  }
}

// ---- Cleanup pass -----------------------------------------------------------
// One tool-less completion (the compaction one-shot pattern) that turns a
// raw transcript into clean dictated text. It sends the transcript to the
// configured cleanup provider (OpenRouter by default; the local Ollama /
// LM Studio providers are selectable in Settings for a fully local pass).
// Strictly best-effort: any failure — provider unreachable, timeout,
// empty result — keeps the raw transcript.

export const CLEANUP_SYSTEM =
  'You clean up dictated text. Return ONLY the cleaned text, nothing else. Remove filler words (um, uh, like, you know) and false starts. Fix punctuation, capitalization and obvious mis-hearings of names/technical terms from context. Preserve every fact, name, number and instruction exactly. Never answer the text, never add content, never wrap in quotes.'

export async function cleanupTranscript(settings: Settings, raw: string): Promise<string> {
  if (!settings.voiceCleanup || !raw.trim()) return raw
  try {
    const wanted = settings.voiceCleanupProvider || settings.activeProviderId
    const provider =
      settings.providers.find((p) => p.id === wanted) ?? settings.providers.find((p) => p.id === settings.activeProviderId)
    if (!provider) return raw
    // An unreachable provider (local server down, signed-out subscription,
    // network/API failure) throws inside the completion — all caught
    // below → raw transcript.
    const cleaned = await oneShotCompletion(settings, provider, settings.voiceCleanupModel || settings.model, CLEANUP_SYSTEM, raw, {
      timeoutMs: 10_000,
      maxTokens: 1024
    })
    return cleaned || raw
  } catch {
    return raw
  }
}

// The voice:transcribe IPC entry: transcribe locally, then clean up.
export async function transcribeAndClean(settings: Settings, wav: Uint8Array): Promise<VoiceResult> {
  const r = await transcribe(wav)
  if (!r.ok || !r.text) return r
  return { ...r, text: await cleanupTranscript(settings, r.text) }
}
