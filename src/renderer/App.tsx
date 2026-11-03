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
  ImageAttachment,
  McpStatus,
  Settings,
  UsageReport
} from '@shared/types'
import SettingsModal from './SettingsModal'
import { BROWSER_DECODABLE_MIMES, IMAGE_EXT_RE, sniffImageMime } from '@shared/imaging'

const MAX_IMAGES = 4 // attachments per message
const MAX_IMAGE_EDGE = 2048 // px on the long edge after downscaling

// Pasted/dropped image → attachment: decode, downscale to at most
// MAX_IMAGE_EDGE on the long edge via canvas, and re-encode as PNG. The
// downscale keeps conversation files (base64 inline) and provider payloads
// sane for full-screen screenshots.
async function fileToAttachment(file: Blob): Promise<ImageAttachment> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('unreadable image'))
      i.src = url
    })
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/png')
    return { mime: 'image/png', dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) }
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
  // conversion. If image candidates were present but NONE could be
  // attached, that is reported — never silently dropped.
  const addImages = async (files: File[], source: 'paste' | 'drop') => {
    if (!files.length) return
    interface Cand {
      file: File
      bytes: Uint8Array
      label: string
    }
    const seenLabels: string[] = []
    const decodable: Cand[] = []
    const rest: Cand[] = []
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
      const cand: Cand = { file: f, bytes, label }
      if (BROWSER_DECODABLE_MIMES.includes(sniffed ?? f.type)) decodable.push(cand)
      else rest.push(cand)
    }
    if (!seenLabels.length) return // nothing image-like: behave exactly as before
    const ordered = [...decodable, ...rest]
    const room = MAX_IMAGES - pending.length
    if (room <= 0) return
    const out: ImageAttachment[] = []
    for (const c of ordered.slice(0, room)) {
      try {
        out.push(await fileToAttachment(c.file))
        continue
      } catch {
        // Canvas couldn't decode it — let the OS codecs try.
      }
      try {
        const r = await api.imagesNormalize(c.bytes)
        if (r.ok && r.attachment) out.push(r.attachment)
      } catch {
        // IPC failure counts as a failed candidate; reported below.
      }
    }
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

  // Paste: pull image parts out of the clipboard into the attachment strip.
  // When the clipboard carries text AND an image, the text paste proceeds
  // normally (no preventDefault) and the image is taken alongside; with an
  // image alone, the default is swallowed so no file name/path text leaks
  // into the composer. A paste with no image candidates is left entirely
  // to the default text handling.
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData
    if (!cd) return
    let hasText = false
    for (const it of Array.from(cd.items)) if (it.type === 'text/plain') hasText = true
    const files = collectFiles(cd).filter(maybeImage)
    if (!files.length) return
    if (!hasText) e.preventDefault()
    void addImages(files, 'paste')
  }

  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = collectFiles(e.dataTransfer)
    if (files.length) void addImages(files, 'drop')
  }

  const send = async () => {
    const text = input.trim()
    if ((!text && !pending.length) || busy) return
    let c = conv
    if (!c) c = await api.newConv(selProject ?? undefined)
    const attachments = pending.length ? pending : undefined
    const withUser: Conversation = {
      ...c,
      title: c.messages.length ? c.title : text.slice(0, 48) || 'Image message',
      messages: [...c.messages, { role: 'user', content: text, ...(attachments ? { attachments } : {}) }]
    }
    setConv(withUser)
    setInput('')
    setPending([])
    setError('')
    setBusyFor(c.id, true)
    api.send({ convId: c.id, text, providerId: settings.activeProviderId, model: settings.model, attachments })
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

      <main className="main">
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

        <footer
          className={'composer-area' + (dragOver ? ' dragover' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {pending.length > 0 && (
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
              <button className="btn primary" onClick={send}>Send</button>
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
