import { useEffect, useState } from 'react'
import type { McpServerConfig, McpStatus, Policy, Provider, Settings, SmbCredential, ToolCategory } from '@shared/types'

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
  const [mp, setMp] = useState(s.activeProviderId)
  const [all, setAll] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const enabled = s.enabledModels?.[mp] ?? []
  const setEnabled = (list: string[]) => setS({ ...s, enabledModels: { ...s.enabledModels, [mp]: list } })

  useEffect(() => {
    setAll([])
    setLoadErr('')
    void window.api.listModels(mp).then(setAll).catch((e) => setLoadErr(String(e.message ?? e)))
  }, [mp])
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

        <h4>Working directory</h4>
        <div className="row">
          <input value={s.workingDir} onChange={(e) => setS({ ...s, workingDir: e.target.value })} />
          <button className="btn" onClick={async () => { const d = await window.api.pickDir(); if (d) setS({ ...s, workingDir: d }) }}>
            Browse…
          </button>
        </div>

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

        <h4>SMB credentials (JSON)</h4>
        <textarea
          rows={8}
          value={smbText}
          onChange={(e) => setSmbText(e.target.value)}
          placeholder={'[{"host":"nas.tailnet.ts.net","username":"me","password":"…"}]'}
        />
        <p className="hint">SSH uses your system ssh (keys, agent, ~/.ssh/config, Tailscale SSH). SMB needs <code>smbclient</code>, or mount shares and use the file tools.</p>

        {err && <div className="err">{err}</div>}
        <div className="row end">
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}
