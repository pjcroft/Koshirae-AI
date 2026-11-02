import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpStatus } from '@shared/types'
import type { ToolDef } from './tools'
import { clip } from './tools'

interface Live {
  name: string
  client: Client
  tools: ToolDef[]
}

let live: Live[] = []
let status: McpStatus[] = []
let chain: Promise<unknown> = Promise.resolve()

export const mcpTools = (): ToolDef[] => live.flatMap((l) => l.tools)
export const getMcpStatus = () => status

export async function stopMcp() {
  const old = live
  live = []
  await Promise.all(old.map((l) => l.client.close().catch(() => {})))
}

export function startMcp(servers: McpServerConfig[]): Promise<McpStatus[]> {
  const p = chain.then(() => doStart(servers))
  chain = p.catch(() => {})
  return p
}

async function doStart(servers: McpServerConfig[]): Promise<McpStatus[]> {
  await stopMcp()
  status = await Promise.all(
    servers
      .filter((s) => s.enabled !== false)
      .map(async (s): Promise<McpStatus> => {
        let client: Client | undefined
        try {
          client = new Client({ name: 'pc-ai', version: '0.1.0' })
          const transport = s.url
            ? new StreamableHTTPClientTransport(new URL(s.url))
            : new StdioClientTransport({
                command: s.command!,
                args: s.args ?? [],
                env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) }
              })
          let timer: NodeJS.Timeout
          await Promise.race([
            client.connect(transport),
            new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('connect timeout')), 20_000)))
          ]).finally(() => clearTimeout(timer))
          const { tools } = await client.listTools()
          const prefix = s.name.replace(/[^a-zA-Z0-9_-]/g, '_')
          const used = new Set<string>()
          const defs: ToolDef[] = tools.map((t) => {
            let nm = `mcp__${prefix}__${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 60)
            while (used.has(nm)) nm = nm.slice(0, 56) + '_' + Math.random().toString(36).slice(2, 5)
            used.add(nm)
            return {
            name: nm,
            description: `[${s.name}] ${t.description ?? t.name}`,
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            category: 'mcp',
            run: async (args, ctx) => {
              const r: any = await client!.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal })
              const text = (r.content ?? [])
                .map((c: any) => (c.type === 'text' ? c.text : `[${c.type} content]`))
                .join('\n')
              return clip(text) + (r.isError ? '\n[tool reported error]' : '')
            }
          }})
          live.push({ name: s.name, client: client!, tools: defs })
          return { name: s.name, ok: true, tools: defs.length }
        } catch (e: any) {
          await client?.close().catch(() => {})
          return { name: s.name, ok: false, tools: 0, error: String(e?.message ?? e) }
        }
      })
  )
  return status
}
