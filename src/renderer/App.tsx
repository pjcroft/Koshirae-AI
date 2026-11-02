import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import logo from './logo.png'
import type { ChatEvent, ChatMessage, Conversation, ConversationMeta, McpStatus, Settings, UsageReport } from '@shared/types'
import SettingsModal from './SettingsModal'

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

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    let c = conv
    if (!c) c = await api.newConv(selProject ?? undefined)
    const withUser: Conversation = {
      ...c,
      title: c.messages.length ? c.title : text.slice(0, 48),
      messages: [...c.messages, { role: 'user', content: text }]
    }
    setConv(withUser)
    setInput('')
    setError('')
    setBusyFor(c.id, true)
    api.send({ convId: c.id, text, providerId: settings.activeProviderId, model: settings.model })
  }

  const answer = (a: Approval, allow: boolean) => {
    api.respond(a.id, allow)
    setApprovals((x) => x.filter((y) => y.id !== a.id))
  }

  const busy = !!conv && busyIds.has(conv.id)
  const myApprovals = approvals.filter((a) => a.convId === conv?.id)
  const msgs = conv?.messages ?? []
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
          <img src={logo} alt="PC AI" />
        </div>
        <h1 className="brand">PC AI</h1>
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
          <span className="cwd" title="Working directory">
            📁 {settings.workingDir}
          </span>
        </header>

        <div className="chat">
          {msgs.length === 0 && !busy && (
            <div className="hero">
              <span className="kicker">⚡ PC AI</span>
              <h2>
                Ask. Run. <span className="grad">Get it done.</span>
              </h2>
              <p className="lede">
                Chat with any model on OpenRouter or a local server. It can read files, run commands, reach servers over
                SSH, SMB and Tailscale, and use your MCP tools — you approve anything risky.
              </p>
              <div className="pills">
                <span>Streaming</span>
                <span>Tool approvals</span>
                <span>MCP</span>
                <span>Local models</span>
              </div>
            </div>
          )}
          {msgs.map((m, i) => {
            if (m.role === 'user') return <div key={i} className="msg user">{m.content}</div>
            if (m.role === 'assistant')
              return (
                <div key={i} className="msg bot">
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
              )
            return null
          })}
          {streaming && (
            <div className="msg bot">
              <Markdown remarkPlugins={[remarkGfm]}>{streaming}</Markdown>
            </div>
          )}
          {error && <div className="err">{error}</div>}
          <div ref={endRef} />
        </div>

        <footer className="composer">
          <textarea
            value={input}
            placeholder="Message PC AI…  (Enter to send, Shift+Enter for newline)"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {busy ? (
            <button className="btn" onClick={() => conv && api.stop(conv.id)}>■ Stop</button>
          ) : (
            <button className="btn primary" onClick={send}>Send</button>
          )}
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
