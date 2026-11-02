import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import type { Settings, ToolCategory } from '@shared/types'

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  category: ToolCategory
  run: (args: any, ctx: ToolCtx) => Promise<string>
}
export interface ToolCtx {
  settings: Settings
  signal: AbortSignal
}

const MAX_OUT = 40_000
const clip = (s: string) =>
  s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s

const expand = (p: string, cwd: string) =>
  resolve(cwd, p.startsWith('~') ? homedir() + p.slice(1) : p)

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

interface ExecOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  signal: AbortSignal
  shell?: boolean
}

export function exec(cmd: string, args: string[], o: ExecOpts): Promise<string> {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      detached: true,
      cwd: o.cwd,
      env: o.env ?? process.env,
      shell: o.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let timedOut = false
    const add = (d: Buffer) => {
      if (out.length < MAX_OUT * 2) out += d.toString()
    }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        res(clip(out) + '\n[killed]')
      }, 1500)
    }
    o.signal.addEventListener('abort', kill, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, o.timeoutMs ?? 120_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      res(`Failed to start ${cmd}: ${e.message}`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      o.signal.removeEventListener('abort', kill)
      res(clip(out) + (timedOut ? '\n[timed out]' : '') + (code ? `\n[exit code ${code}]` : ''))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(o.stdin ?? '')
  })
}

function ssh(host: string, remote: string, ctx: ToolCtx, stdin?: string) {
  if (!host || host.startsWith('-')) return Promise.resolve('Invalid host')
  return exec(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '--', host, remote],
    { signal: ctx.signal, stdin }
  )
}

function smb(host: string, share: string, command: string, ctx: ToolCtx) {
  if (!host || host.startsWith('-')) return Promise.resolve('Invalid host')
  if (/[;\r\n\0]/.test(share) || /[\r\n\0]/.test(host)) return Promise.resolve('Invalid host/share')
  const cred = ctx.settings.smb.find((c) => c.host.toLowerCase() === host.toLowerCase())
  const args = [`//${host}/${share}`, '-c', command]
  const env = { ...process.env }
  if (cred?.username) {
    args.push('-U', cred.username)
    if (cred.password) env.PASSWD = cred.password
    if (cred.domain) args.push('-W', cred.domain)
  } else args.push('-N')
  return exec('smbclient', args, { signal: ctx.signal, env })
}

const str = (description: string) => ({ type: 'string', description })

export const builtinTools: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a text file on this computer (including mounted SMB/NFS shares under /Volumes or /mnt).',
    parameters: { type: 'object', properties: { path: str('Absolute or ~ path') }, required: ['path'] },
    category: 'read',
    run: async ({ path }, c) => clip(await fs.readFile(expand(path, c.settings.workingDir), 'utf8'))
  },
  {
    name: 'list_dir',
    description: 'List a directory on this computer.',
    parameters: { type: 'object', properties: { path: str('Directory path') }, required: ['path'] },
    category: 'read',
    run: async ({ path }, c) => {
      const ents = await fs.readdir(expand(path, c.settings.workingDir), { withFileTypes: true })
      return ents.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n') || '(empty)'
    }
  },
  {
    name: 'write_file',
    description: 'Write (overwrite) a text file on this computer.',
    parameters: {
      type: 'object',
      properties: { path: str('File path'), content: str('Full file content') },
      required: ['path', 'content']
    },
    category: 'write',
    run: async ({ path, content }, c) => {
      const p = expand(path, c.settings.workingDir)
      await fs.writeFile(p, content, 'utf8')
      return `Wrote ${content.length} chars to ${p}`
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command on this computer. Runs in the configured working directory unless cwd is given.',
    parameters: {
      type: 'object',
      properties: { command: str('Shell command'), cwd: str('Optional working directory') },
      required: ['command']
    },
    category: 'exec',
    run: async ({ command, cwd }, c) =>
      exec(command, [], {
        shell: true,
        cwd: cwd ? expand(cwd, c.settings.workingDir) : c.settings.workingDir,
        signal: c.signal
      })
  },
  {
    name: 'ssh_exec',
    description:
      'Run a command on a remote host over SSH (key/agent auth, honours ~/.ssh/config). Works with Tailscale hostnames/MagicDNS and Tailscale SSH.',
    parameters: {
      type: 'object',
      properties: { host: str('[user@]host'), command: str('Remote shell command') },
      required: ['host', 'command']
    },
    category: 'exec',
    run: ({ host, command }, c) => ssh(host, command, c)
  },
  {
    name: 'ssh_read_file',
    description: 'Read a text file on a remote host over SSH.',
    parameters: { type: 'object', properties: { host: str('[user@]host'), path: str('Remote path') }, required: ['host', 'path'] },
    category: 'read',
    run: ({ host, path }, c) => ssh(host, `cat -- ${shq(path)}`, c)
  },
  {
    name: 'ssh_list_dir',
    description: 'List a directory on a remote host over SSH.',
    parameters: { type: 'object', properties: { host: str('[user@]host'), path: str('Remote directory') }, required: ['host', 'path'] },
    category: 'read',
    run: ({ host, path }, c) => ssh(host, `ls -la -- ${shq(path)}`, c)
  },
  {
    name: 'ssh_write_file',
    description: 'Write (overwrite) a text file on a remote host over SSH.',
    parameters: {
      type: 'object',
      properties: { host: str('[user@]host'), path: str('Remote path'), content: str('File content') },
      required: ['host', 'path', 'content']
    },
    category: 'write',
    run: ({ host, path, content }, c) => ssh(host, `cat > ${shq(path)}`, c, content).then((r) => r || 'OK')
  },
  {
    name: 'smb_list',
    description: 'List a folder on an SMB/CIFS share using smbclient. Credentials come from Koshirae AI settings (SMB tab).',
    parameters: {
      type: 'object',
      properties: { host: str('Server name or IP'), share: str('Share name'), path: str('Folder path inside share, default root') },
      required: ['host', 'share']
    },
    category: 'read',
    run: ({ host, share, path }, c) =>
      /[;"\r\n\0]/.test(path || '') ? Promise.resolve('Invalid path') : smb(host, share, `ls "${(path || '').replace(/"/g, '')}${path ? '/' : ''}*"`, c)
  },
  {
    name: 'smb_run',
    description:
      'Run any smbclient command (get, put, mkdir, rm, ...) against an SMB share. For simple file access prefer read_file on a mounted share.',
    parameters: {
      type: 'object',
      properties: { host: str('Server'), share: str('Share'), command: str('smbclient -c command string') },
      required: ['host', 'share', 'command']
    },
    category: 'exec',
    run: ({ host, share, command }, c) => smb(host, share, command, c)
  },
  {
    name: 'tailscale_status',
    description: 'Show Tailscale peers and their IPs/hostnames.',
    parameters: { type: 'object', properties: {} },
    category: 'read',
    run: async (_a, c) => {
      const r = await exec('tailscale', ['status'], { signal: c.signal })
      if (!r.startsWith('Failed to start')) return r
      return exec('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status'], { signal: c.signal })
    }
  },
  {
    name: 'http_fetch',
    description: 'HTTP GET a URL (including LAN / Tailscale addresses) and return the text body.',
    parameters: { type: 'object', properties: { url: str('http(s) URL') }, required: ['url'] },
    category: 'exec', // network egress: always ask by default (prevents silent exfiltration)
    run: async ({ url }, c) => {
      const r = await fetch(url, { signal: c.signal })
      return `HTTP ${r.status}\n` + clip(await r.text())
    }
  }
]

export { clip }
