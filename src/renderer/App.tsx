import { Fragment, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import logo from './logo.png'
import { blobToWav16k } from './voice'
import type {
  ChatEvent,
  ChatMessage,
  Conversation,
  ConversationMeta,
  DocAttachment,
  ImageAttachment,
  McpStatus,
  Settings,
  UsageReport
} from '@shared/types'
import SettingsModal from './SettingsModal'
import { BROWSER_DECODABLE_MIMES, IMAGE_EXT_RE, dedupeDecisions, hashBytes, sniffImageMime } from '@shared/imaging'
import { capDocText, classifyDoc, formatBytes, type DocKind } from '@shared/files'

const MAX_IMAGES = 4 // attachments per message
const MAX_IMAGE_EDGE = 2048 // px on the long edge after downscaling
const MAX_DOCS = 4 // document attachments per message (images + docs ≤ 8 by construction)
const MAX_NATIVE_PDF_BYTES = 10 * 1024 * 1024 // PDFs up to this size also keep their bytes for native file parts

// Chunked base64 for file bytes — a naive spread of a multi-MB buffer
// into String.fromCharCode overflows the argument stack.
function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const DOC_EMOJI: Record<DocKind, string> = { pdf: '📄', docx: '📝', xlsx: '📊', pptx: '📽', text: '📄' }

// One attached document, shown in the composer's strip (with a remove
// button) and in message history (without).
function DocChip({ d, onRemove }: { d: DocAttachment; onRemove?: () => void }) {
  return (
    <div className="attach-doc">
      <span className="doc-emoji">{DOC_EMOJI[d.kind]}</span>
      <span className="doc-name" title={d.name}>
        {d.name}
      </span>
      <span className="doc-meta">
        {formatBytes(d.size)}
        {d.pages ? ` • ${d.pages} pages` : ''}
      </span>
      {onRemove && (
        <button className="x" title="Remove file" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  )
}

// A decoded image: the attachment to store, plus its SOURCE pixel
// dimensions (before downscale). Dimensions are batch-transient — the
// paste dedupe gate compares clipboard format twins by them — and are
// never stored on the attachment itself.
interface DecodedImage {
  attachment: ImageAttachment
  width: number
  height: number
}

// Pasted/dropped image → decoded image: decode, downscale to at most
// MAX_IMAGE_EDGE on the long edge via canvas, and re-encode as PNG. The
// downscale keeps conversation files (base64 inline) and provider payloads
// sane for full-screen screenshots.
async function fileToAttachment(file: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('unreadable image'))
      i.src = url
    })
    const width = img.naturalWidth
    const height = img.naturalHeight
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/png')
    return { attachment: { mime: 'image/png', dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) }, width, height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface Approval {
  id: string
  toolCallId: string
  name: string
  args: string
  category: string
  convId: string
}

const api = window.api

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [convs, setConvs] = useState<ConversationMeta[]>([])
  const [conv, setConv] = useState<Conversation | null>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const setBusyFor = (id: string, on: boolean) =>
    setBusyIds((s) => {
      const n = new Set(s)
      on ? n.add(id) : n.delete(id)
      return n
    })
  const [error, setError] = useState('')
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [models, setModels] = useState<string[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [selProject, setSelProject] = useState<string | null>(null) // null = All chats
  const [mcp, setMcp] = useState<McpStatus[]>([])
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [compacting, setCompacting] = useState(false)
  // Voice dictation: idle → recording → transcribing → idle (or an error
  // line under the composer). Everything happens on-device in the main
  // process; here we only record and insert the resulting text.
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [voiceSecs, setVoiceSecs] = useState(0)
  const [voiceError, setVoiceError] = useState('')
  // Images pasted or dropped into the composer, waiting to ride along with
  // the next send.
  const [pending, setPending] = useState<ImageAttachment[]>([])
  // Documents (PDF / Word / Excel / PowerPoint / text) dropped or pasted
  // alongside the images; `reading` counts extractions in flight.
  const [pendingDocs, setPendingDocs] = useState<DocAttachment[]>([])
  const [reading, setReading] = useState(0)
  const [imgError, setImgError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const voiceStartRef = useRef(0)
  const voiceTimerRef = useRef<number | undefined>(undefined)
  const convRef = useRef<Conversation | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  convRef.current = conv

  const refreshList = () => api.listConvs().then(setConvs)
  const loadUsage = () =>
    api
      .usageGet()
      .then(setUsage)
      .catch(() => {})

  useEffect(() => {
    api.getSettings().then(setSettings)
    loadUsage()
    const t = [1500, 6000, 22000].map((ms) => setTimeout(() => api.mcpStatus().then(setMcp), ms))
    api.mcpStatus().then(setMcp)
    refreshList()
    return api.onEvent((e: ChatEvent) => {
      const cur = e.convId === convRef.current?.id
      if (e.type === 'approval') setApprovals((a) => [...a, e])
      else if (e.type === 'error') {
        setBusyFor(e.convId, false)
        setApprovals((a) => a.filter((x) => x.convId !== e.convId))
        if (cur) {
          setError(e.error)
          setStreaming('')
        }
      } else if (e.type === 'done') {
        setBusyFor(e.convId, false)
        setApprovals((a) => a.filter((x) => x.convId !== e.convId))
        refreshList()
        loadUsage()
      } else if (e.type === 'compacted') {
        // Auto-compaction folded older messages into a summary — re-read the
        // conversation so the divider and context meter reflect it.
        if (cur) void api.getConv(e.convId).then((c) => c && setConv(c))
      } else if (!cur) return
      else if (e.type === 'delta') setStreaming((s) => s + e.text)
      else if (e.type === 'message') {
        setStreaming('')
        setConv((c) => (c ? { ...c, messages: [...c.messages, e.message] } : c))
      }
    })
  }, [])

  useEffect(() => {
    if (!settings) return
    void api.listModels(settings.activeProviderId).then(setModels).catch(() => setModels([]))
    loadUsage()
  }, [settings?.activeProviderId, settings?.providers])

  useEffect(() => {
    const t = setInterval(loadUsage, 5 * 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [conv?.messages.length, streaming, approvals.length])

  // Release the microphone if the component ever unmounts mid-recording.
  useEffect(
    () => () => {
      if (voiceTimerRef.current) window.clearInterval(voiceTimerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    },
    []
  )

  // A file dropped anywhere outside the chat pane must never navigate
  // the window (Electron's default is to open the dropped file). Only
  // file-carrying drags are intercepted, so ordinary text drags keep
  // their native behavior.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])

  if (!settings) return null

  const open = async (id: string) => {
    setError('')
    setStreaming('')
    setConv(await api.getConv(id))
  }
  const newChat = async () => {
    const c = await api.newConv(selProject ?? undefined)
    setConv(c)
    setStreaming('')
    setError('')
    refreshList()
  }
  const addProject = async () => {
    const dir = await api.projectsPickDir()
    if (!dir) return
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
    const p = await api.projectsAdd(name, dir)
    api.getSettings().then(setSettings)
    setSelProject(p.id)
  }
  const removeProject = async (id: string) => {
    await api.projectsRemove(id)
    if (selProject === id) setSelProject(null)
    api.getSettings().then(setSettings)
  }
  const del = async (id: string) => {
    await api.deleteConv(id)
    if (conv?.id === id) setConv(null)
    refreshList()
  }
  const patch = (p: Partial<Settings>) => {
    const s = { ...settings, ...p }
    setSettings(s)
    api.setSettings(s).then(setMcp)
  }

  // Gather every file a paste/drop offers. Declared types are NOT
  // trusted: Electron can report a screenshot PNG item with an empty
  // type, and macOS clipboards may carry TIFF only. Every kind==='file'
  // item plus every entry of .files is a candidate; the bytes decide
  // what it really is (addImages sniffs magic numbers). Deduped because
  // the same file often shows up in both lists.
  const collectFiles = (dt: DataTransfer): File[] => {
    const out: File[] = []
    const seen = new Set<string>()
    const take = (f: File | null) => {
      if (!f) return
      const key = `${f.name}|${f.size}|${f.lastModified}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(f)
    }
    for (const it of Array.from(dt.items)) if (it.kind === 'file') take(it.getAsFile())
    for (const f of Array.from(dt.files)) take(f)
    return out
  }

  // Synchronous "could this be an image?" for the preventDefault decision
  // in onPaste (the real classification needs the bytes, which is async):
  // a declared image type, an image file extension, or an undeclared type
  // (clipboard images frequently declare nothing at all).
  const maybeImage = (f: File): boolean =>
    f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name) || (f.type === '' && !/\.[a-z0-9]{2,5}$/i.test(f.name))

  // Turn candidate files into attachments. Each candidate's bytes are
  // sniffed for a real image signature (declared type / extension are
  // only supporting evidence). Browser-decodable formats go first; each
  // image is decoded on the canvas path, and anything that defeats the
  // canvas (TIFF, HEIC, …) is rescued by the main process's nativeImage
  // conversion.
  //
  // One copied picture arrives as several candidates (the same file via
  // both DataTransfer lists; a macOS screenshot as PNG + TIFF twins with
  // different bytes), so the batch is deduped before anything attaches:
  // byte-identical repeats drop by content hash, and — paste only —
  // later candidates whose source dimensions match an attached one drop
  // as format twins (see dedupeDecisions in @shared/imaging). Dropped
  // duplicates are NOT failures: if image candidates were present but
  // none could be attached, that is reported — never silently dropped.
  const addImages = async (files: File[], source: 'paste' | 'drop') => {
    if (!files.length) return
    interface Cand {
      file: File
      bytes: Uint8Array
      label: string
      hash: string
    }
    const seenLabels: string[] = []
    const decodable: Cand[] = []
    const rest: Cand[] = []
    const seenHashes = new Set<string>()
    for (const f of files) {
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await f.arrayBuffer())
      } catch {
        continue
      }
      const sniffed = sniffImageMime(bytes)
      if (!sniffed && !f.type.startsWith('image/') && !IMAGE_EXT_RE.test(f.name)) continue // not an image candidate
      const label = sniffed ?? (f.type || 'unknown')
      seenLabels.push(label)
      // Content-hash gate: byte-identical repeats within the batch are
      // the same picture offered twice — collect each byte stream once.
      const hash = hashBytes(bytes)
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)
      const cand: Cand = { file: f, bytes, label, hash }
      if (BROWSER_DECODABLE_MIMES.includes(sniffed ?? f.type)) decodable.push(cand)
      else rest.push(cand)
    }
    if (!seenLabels.length) return // nothing image-like: behave exactly as before
    const ordered = [...decodable, ...rest]
    const room = MAX_IMAGES - pending.length
    if (room <= 0) return
    // Decode one candidate: canvas first, nativeImage rescue second.
    // Returns the attachment plus SOURCE dimensions (pre-downscale).
    const decode = async (c: Cand): Promise<DecodedImage | null> => {
      try {
        return await fileToAttachment(c.file)
      } catch {
        // Canvas couldn't decode it — let the OS codecs try.
      }
      try {
        const r = await api.imagesNormalize(c.bytes)
        if (r.ok && r.attachment)
          return { attachment: r.attachment, width: r.width ?? 0, height: r.height ?? 0 }
      } catch {
        // IPC failure counts as a failed candidate; reported below.
      }
      return null
    }
    const decoded: (DecodedImage & { hash: string })[] = []
    for (const c of ordered) {
      // Decisions over a prefix never change as candidates arrive, so
      // once this batch already holds `room` surviving images, stop.
      if (dedupeDecisions(decoded, source).filter((m) => m === 'keep').length >= room) break
      const d = await decode(c)
      if (d) decoded.push({ ...d, hash: c.hash })
    }
    const marks = dedupeDecisions(decoded, source)
    const out = decoded
      .filter((_, i) => marks[i] === 'keep')
      .slice(0, room)
      .map((d) => d.attachment)
    if (out.length) {
      setPending((p) => [...p, ...out].slice(0, MAX_IMAGES))
      setImgError('')
    } else {
      const saw = [...new Set(seenLabels)].join(', ')
      setImgError(
        `Couldn't read the ${source === 'paste' ? 'pasted' : 'dropped'} image (saw: ${saw}) — try copying it as PNG, or drag the file onto the box.`
      )
    }
  }

  // Turn document candidates into attachments. Text files are decoded
  // and capped right here; everything else goes to the main process
  // (files:extract) which pulls the text out of the PDF/Office package.
  // PDFs up to 10 MB also keep their bytes so OpenRouter/OpenAI can read
  // the original file natively. Failures are never silent: each one is
  // appended to `problems` and lands on the error line under the
  // composer, naming the file.
  const addDocs = async (items: { file: File; kind: DocKind }[], problems: string[]) => {
    let slots = MAX_DOCS - pendingDocs.length
    const accepted: DocAttachment[] = []
    for (const { file, kind } of items) {
      const label = file.name || 'a file'
      if (slots <= 0) {
        problems.push(`${label} — skipped: at most ${MAX_DOCS} documents per message`)
        continue
      }
      setReading((r) => r + 1)
      try {
        const buf = await file.arrayBuffer()
        if (kind === 'text') {
          const { text, truncated } = capDocText(new TextDecoder().decode(buf))
          if (!text.trim()) {
            problems.push(`${label} — no readable text`)
            continue
          }
          accepted.push({
            name: label,
            mime: file.type || 'text/plain',
            kind,
            size: file.size,
            text,
            ...(truncated ? { truncated } : {})
          })
        } else {
          const dataBase64 = bytesToBase64(buf)
          const r = await api.extractFile(label, kind, dataBase64)
          if (!r.ok || r.text === undefined) {
            problems.push(`${label} — ${r.error ?? 'could not be read'}`)
            continue
          }
          accepted.push({
            name: label,
            mime: file.type || 'application/octet-stream',
            kind,
            size: file.size,
            text: r.text,
            ...(r.pages ? { pages: r.pages } : {}),
            ...(r.truncated ? { truncated: true } : {}),
            ...(kind === 'pdf' && file.size <= MAX_NATIVE_PDF_BYTES ? { dataBase64 } : {})
          })
        }
        slots--
      } catch (e: any) {
        problems.push(`${label} — ${e?.message ?? 'could not be read'}`)
      } finally {
        setReading((r) => r - 1)
      }
    }
    if (accepted.length) setPendingDocs((d) => [...d, ...accepted].slice(0, MAX_DOCS))
  }

  // The one intake for pasted/dropped files. The first bytes decide the
  // route: anything sniffing as an image takes the existing image flow
  // (unchanged, batch semantics included); anything classifying as a
  // supported document takes the doc flow; a declared image the sniffer
  // doesn't know still gets its chance on the image path; the rest are
  // named on the error line instead of vanishing silently.
  const addFiles = async (files: File[], source: 'paste' | 'drop') => {
    if (!files.length) return
    const imageFiles: File[] = []
    const docItems: { file: File; kind: DocKind }[] = []
    const problems: string[] = []
    for (const f of files) {
      let head: Uint8Array | null = null
      try {
        head = new Uint8Array(await f.slice(0, 16).arrayBuffer())
      } catch {
        head = null
      }
      if (head && sniffImageMime(head)) {
        imageFiles.push(f)
        continue
      }
      const kind = classifyDoc(f.name, f.type)
      if (kind) docItems.push({ file: f, kind })
      else if (f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name)) imageFiles.push(f)
      else problems.push(`${f.name || 'a file'} — unsupported file type`)
    }
    if (imageFiles.length) await addImages(imageFiles, source)
    if (docItems.length) await addDocs(docItems, problems)
    if (problems.length) setImgError((prev) => [prev, ...problems].filter(Boolean).join('\n'))
  }

  // Paste: pull image/document parts out of the clipboard into the
  // attachment strip. When the clipboard carries text AND an attachment,
  // the text paste proceeds normally (no preventDefault) and the
  // attachment is taken alongside; with an attachment alone, the default
  // is swallowed so no file name/path text leaks into the composer. A
  // paste with no attachment candidates is left entirely to the default
  // text handling.
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData
    if (!cd) return
    let hasText = false
    for (const it of Array.from(cd.items)) if (it.type === 'text/plain') hasText = true
    const files = collectFiles(cd).filter((f) => maybeImage(f) || classifyDoc(f.name, f.type))
    if (!files.length) return
    if (!hasText) e.preventDefault()
    void addFiles(files, 'paste')
  }

  const onDrop = (e: ReactDragEvent) => {
    const files = collectFiles(e.dataTransfer)
    setDragOver(false)
    if (!files.length) return // not a file drop (e.g. dragged text): keep the native default
    e.preventDefault()
    void addFiles(files, 'drop')
  }

  const send = async () => {
    const text = input.trim()
    if ((!text && !pending.length && !pendingDocs.length) || busy || reading > 0) return
    let c = conv
    if (!c) c = await api.newConv(selProject ?? undefined)
    const attachments = pending.length ? pending : undefined
    const files = pendingDocs.length ? pendingDocs : undefined
    const withUser: Conversation = {
      ...c,
      title: c.messages.length
        ? c.title
        : text.slice(0, 48) || (files ? `File: ${files[0].name}` : 'Image message'),
      messages: [
        ...c.messages,
        { role: 'user', content: text, ...(attachments ? { attachments } : {}), ...(files ? { files } : {}) }
      ]
    }
    setConv(withUser)
    setInput('')
    setPending([])
    setPendingDocs([])
    setError('')
    setBusyFor(c.id, true)
    api.send({ convId: c.id, text, providerId: settings.activeProviderId, model: settings.model, attachments, files })
  }

  const answer = (a: Approval, allow: boolean) => {
    api.respond(a.id, allow)
    setApprovals((x) => x.filter((y) => y.id !== a.id))
  }

  const compactNow = async () => {
    if (!conv || compacting) return
    setCompacting(true)
    try {
      const r = await api.compactChat(conv.id)
      if (r.compacted) {
        const fresh = await api.getConv(conv.id)
        if (fresh) setConv(fresh)
        refreshList()
      }
    } catch {
    } finally {
      setCompacting(false)
    }
  }

  const insertAtCursor = (text: string) => {
    const ta = inputRef.current
    // The textarea's live value is the source of truth (state may lag a
    // render behind what the user typed while recording).
    const cur = ta?.value ?? input
    const start = ta?.selectionStart ?? cur.length
    const end = ta?.selectionEnd ?? cur.length
    const before = cur.slice(0, start)
    const sep = before && !/\s$/.test(before) ? ' ' : ''
    setInput(before + sep + text + cur.slice(end))
    const pos = (before + sep + text).length
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(pos, pos)
    })
  }

  const finishVoice = async (blob: Blob) => {
    setVoiceState('transcribing')
    try {
      const wav = await blobToWav16k(blob)
      const r = await api.voiceTranscribe(wav)
      if (r.ok && r.text) insertAtCursor(r.text)
      else setVoiceError(r.error ?? 'Transcription failed.')
    } catch (e: any) {
      setVoiceError(`Transcription failed: ${e?.message ?? e}`)
    } finally {
      setVoiceState('idle')
    }
  }

  const startVoice = async () => {
    setVoiceError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        void finishVoice(new Blob(chunksRef.current, { type: rec.mimeType }))
      }
      mediaRef.current = rec
      rec.start()
      voiceStartRef.current = Date.now()
      setVoiceSecs(0)
      setVoiceState('recording')
      voiceTimerRef.current = window.setInterval(
        () => setVoiceSecs(Math.floor((Date.now() - voiceStartRef.current) / 1000)),
        250
      )
    } catch (e: any) {
      setVoiceError(`Microphone unavailable: ${e?.message ?? e}`)
    }
  }

  const toggleVoice = () => {
    if (voiceState === 'recording') {
      if (voiceTimerRef.current) window.clearInterval(voiceTimerRef.current)
      mediaRef.current?.stop() // onstop hands the recording to finishVoice
    } else if (voiceState === 'idle') void startVoice()
  }

  const busy = !!conv && busyIds.has(conv.id)
  const myApprovals = approvals.filter((a) => a.convId === conv?.id)
  const msgs = conv?.messages ?? []

  // Context meter: the same chars/4 estimate the main process uses, over
  // what will actually be sent — the compaction summary (if any) plus the
  // messages not folded into it.
  const upTo = conv?.summaryUpTo ?? 0
  const unsummarized = msgs.length - upTo
  const estTok = (s: string) => Math.ceil(s.length / 4)
  const ctxTokens =
    (conv?.summary ? estTok(conv.summary) : 0) +
    msgs
      .slice(upTo)
      .reduce(
        (n, m) =>
          n +
          estTok(typeof m.content === 'string' ? m.content : '') +
          (m.files ?? []).reduce((k, d) => k + estTok(d.text), 0) +
          (m.tool_calls ?? []).reduce((k, tc) => k + estTok(tc.function.arguments), 0),
        0
      )
  const ctxLabel = ctxTokens >= 1000 ? `~${(ctxTokens / 1000).toFixed(ctxTokens >= 10_000 ? 0 : 1)}K` : `~${ctxTokens}`
  const results = new Map<string, ChatMessage>()
  msgs.forEach((m) => m.tool_call_id && results.set(m.tool_call_id, m))

  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
  const usageSrc =
    !usage || !activeProvider
      ? undefined
      : activeProvider.kind === 'claude-sub'
        ? usage.claude
        : activeProvider.kind === 'chatgpt-sub'
          ? usage.chatgpt
          : activeProvider.baseUrl.includes('openrouter.ai') || activeProvider.id === 'openrouter'
            ? usage.openrouter
            : undefined
  const usageName =
    activeProvider?.kind === 'claude-sub'
      ? 'Claude plan'
      : activeProvider?.kind === 'chatgpt-sub'
        ? 'ChatGPT plan'
        : 'OpenRouter'
  const usageText =
    usageSrc?.ok && usageSrc.lines.length
      ? `${usageName}: ${usageSrc.lines
          .slice(0, 2)
          .map((l) => `${l.label} ${l.value}`)
          .join(' · ')}`
      : ''

  return (
    <div className="app">
      <aside className="side">
        <div className="badge">
          <img src={logo} alt="Koshirae AI" />
        </div>
        <h1 className="brand">Koshirae AI</h1>
        <p className="eyebrow">Chat · Tools · Agents</p>
        <button className="btn primary" onClick={newChat}>
          + New chat
        </button>
        <div className="projects">
          <div className="proj-head">
            <span>Projects</span>
            <button className="proj-add" title="New project" onClick={addProject}>
              + New
            </button>
          </div>
          <div className={'proj' + (selProject === null ? ' active' : '')} onClick={() => setSelProject(null)}>
            <span>All chats</span>
          </div>
          {(settings.projects ?? []).map((p) => (
            <div
              key={p.id}
              className={'proj' + (selProject === p.id ? ' active' : '')}
              title={p.path}
              onClick={() => setSelProject(p.id)}
            >
              <span>{p.name}</span>
              <button
                className="x"
                title="Remove project (folder is not touched)"
                onClick={(e) => {
                  e.stopPropagation()
                  removeProject(p.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="convs">
          {(selProject ? convs.filter((c) => c.projectId === selProject) : convs).map((c) => {
            const tag =
              selProject === null && c.projectId
                ? settings.projects?.find((p) => p.id === c.projectId)?.name
                : undefined
            return (
              <div key={c.id} className={'conv' + (conv?.id === c.id ? ' active' : '')} onClick={() => open(c.id)}>
                <span>{c.title}</span>
                {tag && <span className="ptag">{tag}</span>}
                <button
                  className="x"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    del(c.id)
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
        <p className="brand-note">
          <i className={mcp.some((m) => !m.ok) ? 'bad' : ''} />
          {mcp.length ? `${mcp.filter((m) => m.ok).length}/${mcp.length} MCP servers` : 'No MCP servers'}
        </p>
        {usageText && (
          <p className="usage-line" title="Open Settings" onClick={() => setShowSettings(true)}>
            {usageText}
          </p>
        )}
        <button className="btn" onClick={() => setShowSettings(true)}>
          ⚙ Settings
        </button>
      </aside>

      <main
        className={'main' + (dragOver ? ' dragover' : '')}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={(e) => {
          // dragleave fires when entering child elements too — only a
          // leave whose destination is outside the pane ends the drag.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
        }}
        onDrop={onDrop}
      >
        {dragOver && <div className="drop-overlay">Drop files to attach</div>}
        <header className="top">
          <select value={settings.activeProviderId} onChange={(e) => patch({ activeProviderId: e.target.value })}>
            {settings.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {(() => {
            const enabled = settings.enabledModels?.[settings.activeProviderId] ?? []
            return enabled.length ? (
              <select className="model" value={settings.model} onChange={(e) => patch({ model: e.target.value })}>
                {!enabled.includes(settings.model) && <option value={settings.model}>{settings.model}</option>}
                {enabled.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <>
                <input className="model" list="models" value={settings.model} placeholder="model id"
                  onChange={(e) => patch({ model: e.target.value })} />
                <datalist id="models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </>
            )
          })()}
          {conv && (
            <span className="ctx" title="Estimated context sent to the model: the compaction summary (if any) plus the messages after it">
              context {ctxLabel} tokens
            </span>
          )}
          {conv && (
            <button
              className="btn ctx-btn"
              disabled={busy || compacting || unsummarized < 16}
              title="Summarize the older messages into a compact summary to shrink the context. The full history stays saved."
              onClick={compactNow}
            >
              {compacting ? 'Compacting…' : 'Compact'}
            </button>
          )}
          <span className="cwd" title="Working directory">
            📁 {settings.workingDir}
          </span>
        </header>

        <div className="chat">
          {msgs.length === 0 && !busy && (
            <div className="hero">
              <span className="kicker">⚡ KOSHIRAE AI</span>
              <h2>
                Ask. Run. <span className="grad">Get it done.</span>
              </h2>
              <p className="lede">
                Named for the koshirae — the crafted fittings that turn a bare blade into a finished sword. Bring your
                own blade: Claude or ChatGPT on your subscription, any model on OpenRouter, or a local one. Koshirae
                fits it with tools, projects and memory — reading files, running commands, reaching servers over SSH,
                SMB and Tailscale, tracking your usage — and you approve anything risky.
              </p>
              <div className="pills">
                <span>Subscriptions</span>
                <span>Projects</span>
                <span>Memory</span>
                <span>Tool approvals</span>
                <span>MCP</span>
                <span>🎤 Voice dictation</span>
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <Fragment key={i}>
              {upTo > 0 && i === upTo && (
                <div className="compact-divider">Earlier context compacted into a summary — full history still saved</div>
              )}
              {m.role === 'user' ? (
                <div className="msg user">
                  {m.content}
                  {!!m.attachments?.length && (
                    <div className="msg-imgs">
                      {m.attachments.map((a, j) => (
                        <img key={j} src={`data:${a.mime};base64,${a.dataBase64}`} alt="attached image" />
                      ))}
                    </div>
                  )}
                  {!!m.files?.length && (
                    <div className="msg-files">
                      {m.files.map((d, j) => (
                        <DocChip key={j} d={d} />
                      ))}
                    </div>
                  )}
                </div>
              ) : m.role === 'assistant' ? (
                <div className="msg bot">
                  {m.content && <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>}
                  {m.tool_calls?.map((tc) => {
                    const r = results.get(tc.id)
                    const pend = myApprovals.find((a) => a.toolCallId === tc.id)
                    return (
                      <details key={tc.id} className="tool" open={!!pend}>
                        <summary>
                          <b>{tc.function.name}</b> {r ? '✓' : pend ? '⏸ waiting' : '…'}
                        </summary>
                        <pre>{tc.function.arguments}</pre>
                        {r && <pre className="out">{r.content}</pre>}
                        {pend && (
                          <div className="approve">
                            <span>Allow this {pend.category} action?</span>
                            <button className="btn primary" onClick={() => answer(pend, true)}>Allow</button>
                            <button className="btn" onClick={() => answer(pend, false)}>Deny</button>
                          </div>
                        )}
                      </details>
                    )
                  })}
                </div>
              ) : null}
            </Fragment>
          ))}
          {streaming && (
            <div className="msg bot">
              <Markdown remarkPlugins={[remarkGfm]}>{streaming}</Markdown>
            </div>
          )}
          {error && <div className="err">{error}</div>}
          <div ref={endRef} />
        </div>

        <footer className="composer-area">
          {(pending.length > 0 || pendingDocs.length > 0 || reading > 0) && (
            <div className="attach-strip">
              {pending.map((a, i) => (
                <div className="attach-thumb" key={i}>
                  <img src={`data:${a.mime};base64,${a.dataBase64}`} alt="pending attachment" />
                  <button
                    className="x"
                    title="Remove image"
                    onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              {pendingDocs.map((d, i) => (
                <DocChip
                  key={`doc-${i}`}
                  d={d}
                  onRemove={() => setPendingDocs((p) => p.filter((_, j) => j !== i))}
                />
              ))}
              {reading > 0 && <span className="doc-meta reading">Reading {reading} file{reading > 1 ? 's' : ''}…</span>}
            </div>
          )}
          <div className="composer">
            <textarea
              ref={inputRef}
              value={input}
              placeholder="Message Koshirae AI…  (Enter to send, Shift+Enter for newline)"
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button
              className={'btn mic' + (voiceState === 'recording' ? ' rec' : '')}
              onClick={toggleVoice}
              disabled={voiceState === 'transcribing'}
              title={
                voiceState === 'recording'
                  ? 'Stop recording'
                  : 'Voice dictation — transcribed on this Mac with Whisper'
              }
            >
              {voiceState === 'transcribing' ? (
                <span className="spin" />
              ) : voiceState === 'recording' ? (
                `● ${voiceSecs}s`
              ) : (
                '🎤'
              )}
            </button>
            {busy ? (
              <button className="btn" onClick={() => conv && api.stop(conv.id)}>■ Stop</button>
            ) : (
              <button
                className="btn primary"
                onClick={send}
                disabled={reading > 0}
                title={reading > 0 ? 'Reading attached files…' : undefined}
              >
                Send
              </button>
            )}
          </div>
          {voiceError && <div className="voice-err">{voiceError}</div>}
          {imgError && <div className="voice-err">{imgError}</div>}
        </footer>
      </main>

      {showSettings && (
        <SettingsModal
          settings={settings}
          mcp={mcp}
          onClose={() => setShowSettings(false)}
          onSave={(s) => {
            setSettings(s)
            api.setSettings(s).then(setMcp)
            setShowSettings(false)
          }}
        />
      )}
    </div>
  )
}
