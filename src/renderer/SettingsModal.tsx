import { useEffect, useState } from 'react'
import type { McpServerConfig, McpStatus, Policy, Provider, Settings, SmbCredential, SubStatus, SubWhich, ToolCategory, UsageReport, VoiceStatus } from '@shared/types'

const PRESETS: Omit<Provider, 'id'>[] = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '' },
  { name: 'Anthropic (OpenAI-compat)', baseUrl: 'https://api.anthropic.com/v1', apiKey: '' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '' }
]

export default function SettingsModal(props: {
  settings: Settings
  mcp: McpStatus[]
  onSave: (s: Settings) => void
  onClose: () => void
}) {
  const [s, setS] = useState<Settings>(props.settings)
  const [mcpText, setMcpText] = useState(JSON.stringify(s.mcpServers, null, 2))
  const [smbText, setSmbText] = useState(JSON.stringify(s.smb, null, 2))
  const [err, setErr] = useState('')
  const [subs, setSubs] = useState<SubStatus | null>(null)
  const [login, setLogin] = useState<{ which: SubWhich; url?: string; instructions?: string; progress?: string } | null>(null)
  const [codeText, setCodeText] = useState('')
  const [subsErr, setSubsErr] = useState('')
  const [usage, setUsage] = useState<UsageReport | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [mp, setMp] = useState(s.activeProviderId)
  const [all, setAll] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [vstat, setVstat] = useState<VoiceStatus | null>(null)
  const [dl, setDl] = useState(false)
  const [dlPct, setDlPct] = useState(0)
  const [dlErr, setDlErr] = useState('')
  const refreshVoice = () =>
    void window.api
      .voiceStatus()
      .then(setVstat)
      .catch(() => {})
  const downloadModel = async () => {
    setDl(true)
    setDlPct(0)
    setDlErr('')
    const r = await window.api.voiceDownloadModel().catch((e: any) => ({ ok: false, error: String(e?.message ?? e) }))
    setDl(false)
    if (!r.ok) setDlErr(r.error ?? 'Download failed')
    refreshVoice()
  }
  const enabled = s.enabledModels?.[mp] ?? []
  const setEnabled = (list: string[]) => setS({ ...s, enabledModels: { ...s.enabledModels, [mp]: list } })

  useEffect(() => {
    setAll([])
    setLoadErr('')
    void window.api.listModels(mp).then(setAll).catch((e) => setLoadErr(String(e.message ?? e)))
  }, [mp])

  const loadUsage = () => {
    setUsageLoading(true)
    void window.api
      .usageGet()
      .then(setUsage)
      .catch(() => setUsage({}))
      .finally(() => setUsageLoading(false))
  }

  useEffect(() => {
    void window.api.subsStatus().then(setSubs).catch(() => {})
    loadUsage()
    refreshVoice()
    const offProgress = window.api.onVoiceModelProgress(({ pct }) => setDlPct(pct))
    const offAuth = window.api.onSubsAuth((e) => {
      setLogin((l) =>
        l && l.which === e.which
          ? { ...l, url: e.url ?? l.url, instructions: e.instructions ?? l.instructions, progress: e.progress ?? l.progress }
          : l
      )
    })
    const offDone = window.api.onSubsDone((e) => {
      setLogin((l) => (l?.which === e.which ? null : l))
      setCodeText('')
      setSubsErr(e.ok ? '' : e.error ?? 'Sign-in failed')
      void window.api.subsStatus().then(setSubs).catch(() => {})
      if (e.ok) loadUsage()
    })
    return () => {
      offAuth()
      offDone()
      offProgress()
    }
  }, [])
  const shown = [...new Set([...enabled, ...all])]
    .filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 300)

  const setProv = (i: number, p: Partial<Provider>) =>
    setS({ ...s, providers: s.providers.map((x, j) => (j === i ? { ...x, ...p } : x)) })

  const save = () => {
    try {
      const mcpServers = JSON.parse(mcpText) as McpServerConfig[]
      const smb = JSON.parse(smbText) as SmbCredential[]
      if (!Array.isArray(mcpServers) || !Array.isArray(smb)) throw new Error('MCP and SMB must be JSON arrays')
      props.onSave({ ...s, mcpServers, smb })
    } catch (e: any) {
      setErr(e.message)
    }
  }

  return (
    <div className="modal-back" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <h4>Providers</h4>
        {s.providers.map((p, i) => (
          <div className="row" key={p.id}>
            <input value={p.name} onChange={(e) => setProv(i, { name: e.target.value })} placeholder="Name" />
            <input value={p.baseUrl} onChange={(e) => setProv(i, { baseUrl: e.target.value })} placeholder="Base URL" />
            <input
              type="password"
              value={p.apiKey}
              onChange={(e) => setProv(i, { apiKey: e.target.value })}
              placeholder="API key"
            />
            <button className="btn" onClick={() => setS({ ...s, providers: s.providers.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <select
          value=""
          onChange={(e) => {
            const pr = PRESETS[+e.target.value]
            if (pr) setS({ ...s, providers: [...s.providers, { ...pr, id: crypto.randomUUID() }] })
          }}
        >
          <option value="">+ Add provider…</option>
          {PRESETS.map((p, i) => (
            <option key={p.name} value={i}>{p.name}</option>
          ))}
        </select>

        {!window.api.mobile && (
          <>
        <h4>Subscription accounts</h4>
        {(
          [
            { which: 'anthropic', label: 'Claude (Pro/Max)', btn: 'Sign in with Claude' },
            { which: 'codex', label: 'ChatGPT (Plus/Pro)', btn: 'Sign in with ChatGPT' }
          ] as { which: SubWhich; label: string; btn: string }[]
        ).map(({ which, label, btn }) => {
          const st = subs?.[which]
          const active = login?.which === which
          return (
            <div key={which}>
              <div className="row">
                <span>
                  {label}: {st ? (st.signedIn ? 'Signed in' : 'Not signed in') : '…'}
                </span>
                {st?.signedIn ? (
                  <button className="btn" onClick={() => void window.api.subsLogout(which).then(setSubs)}>
                    Sign out
                  </button>
                ) : (
                  <button
                    className="btn"
                    disabled={!!login}
                    onClick={() => {
                      setSubsErr('')
                      setLogin({ which })
                      void window.api.subsLogin(which)
                    }}
                  >
                    {btn}
                  </button>
                )}
              </div>
              {active && login && (
                <>
                  <p className="hint">
                    {login.progress || login.instructions || 'A sign-in page should open in your browser — finish signing in there.'}
                  </p>
                  {login.url && (
                    <div className="row">
                      <button className="btn" onClick={() => window.open(login.url)}>
                        Reopen sign-in page
                      </button>
                    </div>
                  )}
                  <div className="row">
                    <input
                      value={codeText}
                      onChange={(e) => setCodeText(e.target.value)}
                      placeholder="Stuck? Paste the redirect URL or code from the browser here"
                    />
                    <button className="btn" onClick={() => void window.api.subsSubmitCode(codeText)}>
                      Submit
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
        {subsErr && <div className="err">{subsErr}</div>}
        <p className="hint">
          Signing in adds your plan to the matching subscription provider above. Usage counts against your Claude /
          ChatGPT plan limits, not an API key.
        </p>

        <h4>Usage</h4>
        <div className="row">
          <button className="btn" onClick={loadUsage} disabled={usageLoading}>
            {usageLoading ? 'Refreshing…' : 'Refresh'}
          </button>
          {usageLoading && usage === null && <span className="hint">Loading…</span>}
        </div>
        {usage !== null &&
          (
            [
              { key: 'openrouter', name: 'OpenRouter' },
              { key: 'claude', name: 'Claude plan' },
              { key: 'chatgpt', name: 'ChatGPT plan' }
            ] as const
          ).map(({ key, name }) => {
            const src = usage[key]
            if (!src) return null
            return (
              <div key={key} className="usage-src">
                <div className="usage-name">{name}</div>
                {src.ok ? (
                  src.lines.map((l) => (
                    <div key={l.label} className="usage-row">
                      <span>{l.label}</span>
                      <span>{l.value}</span>
                    </div>
                  ))
                ) : (
                  <div className="mcp-stat bad">{src.error ?? 'Unavailable'}</div>
                )}
              </div>
            )
          })}
        {usage !== null && !usage.openrouter && !usage.claude && !usage.chatgpt && (
          <p className="hint">Nothing to show yet — add an OpenRouter key or sign in above.</p>
        )}

          </>
        )}

        <h4>Web search</h4>
        <div className="row">
          <input
            value={s.searxngUrl}
            onChange={(e) => setS({ ...s, searxngUrl: e.target.value })}
            placeholder="http://your-server:8899"
          />
        </div>
        <p className="hint">Used by the web_search tool. Point it at a SearXNG instance with JSON output enabled.</p>

        {!window.api.mobile && (
          <>
        <h4>Voice dictation</h4>
        <p className="hint">
          {vstat === null
            ? 'Checking engine and model…'
            : vstat.engineFound
              ? `Engine: whisper-cli found (${vstat.enginePath})`
              : 'Engine: whisper-cli not found — install it with: brew install whisper-cpp'}
        </p>
        <div className="row">
          {vstat?.modelPresent ? (
            <span>
              Model: large-v3-turbo ready
              {vstat.modelSize ? ` (${(vstat.modelSize / 1e9).toFixed(2)} GB)` : ''}
            </span>
          ) : (
            <>
              <span>Model: not downloaded (~1.6 GB)</span>
              <button className="btn" onClick={() => void downloadModel()} disabled={dl}>
                {dl ? `Downloading… ${dlPct}%` : 'Download model'}
              </button>
            </>
          )}
        </div>
        {dl && (
          <div className="row">
            <div className="dl-progress">
              <i style={{ width: `${dlPct}%` }} />
            </div>
          </div>
        )}
        {dlErr && <div className="err">{dlErr}</div>}
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={s.voiceCleanup}
              onChange={(e) => setS({ ...s, voiceCleanup: e.target.checked })}
            />{' '}
            Clean up transcripts with a model before inserting them
          </label>
        </div>
        <div className="row">
          <select
            value={s.voiceCleanupProvider}
            onChange={(e) => setS({ ...s, voiceCleanupProvider: e.target.value })}
          >
            {s.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="">Use active provider</option>
          </select>
          <input
            value={s.voiceCleanupModel}
            onChange={(e) => setS({ ...s, voiceCleanupModel: e.target.value })}
            placeholder="Cleanup model id"
          />
        </div>
        <p className="hint">
          Cleanup sends the transcript to the selected provider for polishing. Choose the Ollama or LM Studio
          provider instead if you want cleanup fully local (the LM Studio slot can also be pointed at
          AnythingLLM's local API). If the cleanup call fails, the raw transcript is inserted instead.
        </p>

          </>
        )}

        <h4>Models shown in chat</h4>
        <div className="row">
          <select value={mp} onChange={(e) => setMp(e.target.value)}>
            {s.providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models…" />
          <button className="btn" onClick={() => setEnabled([...new Set([...enabled, ...shown])])}>Select shown</button>
          <button className="btn" onClick={() => setEnabled([])}>Clear</button>
        </div>
        <p className="hint">
          {enabled.length ? `${enabled.length} selected — only these appear in the chat picker.` : 'None selected — chat shows a free-text model box.'}
          {loadErr && ` Could not load list (${loadErr}); check provider URL/key and reopen.`}
        </p>
        <div className="modellist">
          {shown.map((m) => (
            <label key={m}>
              <input type="checkbox" checked={enabled.includes(m)}
                onChange={(e) => setEnabled(e.target.checked ? [...enabled, m] : enabled.filter((x) => x !== m))} />
              {m}
            </label>
          ))}
        </div>

        <h4>System prompt</h4>
        <textarea rows={10} value={s.systemPrompt} onChange={(e) => setS({ ...s, systemPrompt: e.target.value })} />

        {!window.api.mobile && (
          <>
        <h4>Working directory</h4>
        <div className="row">
          <input value={s.workingDir} onChange={(e) => setS({ ...s, workingDir: e.target.value })} />
          <button className="btn" onClick={async () => { const d = await window.api.pickDir(); if (d) setS({ ...s, workingDir: d }) }}>
            Browse…
          </button>
        </div>

          </>
        )}

        <h4>Tool approvals</h4>
        <div className="row">
          {(['read', 'write', 'exec', 'mcp'] as ToolCategory[]).map((c) => (
            <label key={c}>
              {c}{' '}
              <select value={s.policy[c]} onChange={(e) => setS({ ...s, policy: { ...s.policy, [c]: e.target.value as Policy } })}>
                <option value="ask">ask</option>
                <option value="allow">auto-allow</option>
              </select>
            </label>
          ))}
        </div>

        <h4>MCP servers (JSON)</h4>
        <textarea
          rows={12}
          value={mcpText}
          onChange={(e) => setMcpText(e.target.value)}
          placeholder={'[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/home/me"]}]'}
        />
        {props.mcp.map((m) => (
          <div key={m.name} className={'mcp-stat ' + (m.ok ? 'ok' : 'bad')}>
            {m.name}: {m.ok ? `${m.tools} tools` : m.error}
          </div>
        ))}

        {!window.api.mobile && (
          <>
        <h4>SMB credentials (JSON)</h4>
        <textarea
          rows={8}
          value={smbText}
          onChange={(e) => setSmbText(e.target.value)}
          placeholder={'[{"host":"nas.tailnet.ts.net","username":"me","password":"…"}]'}
        />
        <p className="hint">SSH uses your system ssh (keys, agent, ~/.ssh/config, Tailscale SSH). SMB needs <code>smbclient</code>, or mount shares and use the file tools.</p>

          </>
        )}

        {err && <div className="err">{err}</div>}
        <div className="row end">
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
