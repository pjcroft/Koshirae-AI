import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type { Conversation, Project, Settings, SubWhich } from '@shared/types'
import * as store from './store'
import { compactConversation, deleted, isRunning, listModels, respondApproval, runAgent, stopAll, stopConv } from './agent'
import { getMcpStatus, startMcp, stopMcp } from './mcp'
import { logout as subsLogout, startLogin, subStatus, submitCode } from './subs'
import { getUsage } from './usage'

// The main process is an ES module (see electron.vite.config.ts) so that
// ESM-only dependencies such as @mariozechner/pi-ai load natively.
const mainDir = dirname(fileURLToPath(import.meta.url))

let win: BrowserWindow | null = null
let settings: Settings

// GUI apps on macOS/Linux often miss the login-shell PATH (npx, uvx, tailscale, ...).
function fixPath(): Promise<void> {
  return new Promise((res) => {
    const sh = process.env.SHELL || '/bin/bash'
    execFile(sh, ['-ilc', 'echo -n "__P__$PATH"'], { timeout: 5000 }, (_e, out) => {
      const m = /__P__(.*)$/.exec(out || '')
      if (m && m[1].includes(':') && !/\s/.test(m[1].replace(/\/[^:]*/g, ''))) process.env.PATH = m[1]
      res()
    })
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0b1220',
    title: 'PC AI',
    icon: join(mainDir, '../../resources/logo.png'),
    webPreferences: { preload: join(mainDir, '../preload/index.js'), sandbox: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  const guard = (e: Electron.Event, url: string) => {
    if (url === win!.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(mainDir, '../renderer/index.html'))
}

const provider = (id: string) => settings.providers.find((p) => p.id === id) ?? settings.providers[0]

app.whenReady().then(async () => {
  app.setName('PC AI')
  await fixPath()
  settings = await store.loadSettings()
  startMcp(settings.mcpServers)

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', async (_e, s: Settings) => {
    const mcpChanged = JSON.stringify(s.mcpServers) !== JSON.stringify(settings.mcpServers)
    // Subscription credentials are managed only via the subs:* IPC; renderer state may be
    // stale (e.g. sign-in finished while Settings was closed), so never let a settings
    // save wipe them.
    settings = { ...s, subscriptions: settings.subscriptions }
    await store.saveSettings(settings)
    return mcpChanged ? startMcp(settings.mcpServers) : getMcpStatus()
  })
  ipcMain.handle('convs:list', () => store.listConvs())
  ipcMain.handle('convs:get', (_e, id: string) => store.loadConv(id))
  ipcMain.handle('convs:new', async (_e, projectId?: string) => {
    const c: Conversation = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      providerId: settings.activeProviderId,
      model: settings.model,
      ...(projectId ? { projectId } : {}),
      messages: []
    }
    await store.saveConv(c)
    return c
  })
  ipcMain.handle('convs:delete', async (_e, id: string) => {
    deleted.add(id)
    stopConv(id)
    await store.deleteConv(id)
  })
  ipcMain.handle('models:list', (_e, id: string) => listModels(provider(id), settings))
  ipcMain.handle('chat:send', async (_e, a: { convId: string; text: string; providerId: string; model: string }) => {
    const conv = await store.loadConv(a.convId)
    if (!conv || !win) {
      win?.webContents.send('chat:event', { convId: a.convId, type: 'error', error: 'Conversation not found' })
      return
    }
    if (isRunning(a.convId)) return
    if (!provider(a.providerId)) {
      win.webContents.send('chat:event', { convId: a.convId, type: 'error', error: 'No provider configured' })
      return
    }
    if (conv.messages.length === 0) conv.title = a.text.slice(0, 48)
    conv.providerId = a.providerId
    conv.model = a.model
    conv.messages.push({ role: 'user', content: a.text })
    await store.saveConv(conv)
    await runAgent(win, conv, settings, provider(a.providerId), a.model)
  })
  ipcMain.handle('chat:stop', (_e, id: string) => stopConv(id))
  ipcMain.handle('chat:compact', async (_e, convId: string) => {
    const conv = await store.loadConv(convId)
    if (!conv) return { ok: false, compacted: false, summaryUpTo: 0 }
    // Never compact under an active run — the run is reading the same history.
    if (isRunning(convId)) return { ok: false, compacted: false, summaryUpTo: conv.summaryUpTo ?? 0 }
    const r = await compactConversation(conv, settings, provider(conv.providerId), conv.model || settings.model, { force: true })
    return { ok: true, compacted: r.compacted, summaryUpTo: r.summaryUpTo }
  })
  ipcMain.handle('approval:respond', (_e, id: string, allow: boolean) => respondApproval(id, allow))
  ipcMain.handle('mcp:status', () => getMcpStatus())
  ipcMain.handle('subs:status', () => subStatus(settings))
  ipcMain.handle('subs:login', (_e, which: SubWhich) => {
    if (win) void startLogin(win, settings, which) // progress/results arrive via subs:auth / subs:done
  })
  ipcMain.handle('subs:submit', (_e, code: string) => submitCode(code))
  ipcMain.handle('subs:logout', async (_e, which: SubWhich) => {
    await subsLogout(settings, which)
    return subStatus(settings)
  })
  ipcMain.handle('usage:get', () => getUsage(settings))
  ipcMain.handle('projects:pick-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('projects:add', async (_e, name: string, path: string) => {
    const p: Project = { id: randomUUID(), name, path }
    settings = { ...settings, projects: [...(settings.projects ?? []), p] }
    await store.saveSettings(settings)
    // Seed the project's memory file — only when the folder doesn't have one
    // yet; an existing PROJECT.md is the user's and is never overwritten.
    try {
      const memFile = join(path, 'PROJECT.md')
      if (!existsSync(memFile)) {
        const created = new Date().toISOString().slice(0, 10)
        await writeFile(memFile, `# ${name}\n\nProject folder: ${path}\nCreated: ${created}\n\n## Notes\n\n## Decisions\n`)
      }
    } catch {}
    return p
  })
  ipcMain.handle('projects:remove', async (_e, id: string) => {
    // Removes only the record — the folder and its files are never touched.
    // Chats keep their projectId; a dangling id behaves as "no project".
    settings = { ...settings, projects: (settings.projects ?? []).filter((p) => p.id !== id) }
    await store.saveSettings(settings)
  })
  ipcMain.handle('dialog:dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('before-quit', () => stopAll())
app.on('window-all-closed', () => {
  stopMcp().finally(() => app.quit())
})
