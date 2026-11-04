import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ChatEvent, SubsAuthEvent, SubsDoneEvent } from '@shared/types'

const inv = (ch: string, ...a: unknown[]) => ipcRenderer.invoke(ch, ...a)

const api: Api = {
  getSettings: () => inv('settings:get'),
  setSettings: (s) => inv('settings:set', s),
  listConvs: () => inv('convs:list'),
  getConv: (id) => inv('convs:get', id),
  newConv: (projectId) => inv('convs:new', projectId),
  deleteConv: (id) => inv('convs:delete', id),
  projectsPickDir: () => inv('projects:pick-dir'),
  projectsAdd: (name, path) => inv('projects:add', name, path),
  projectsRemove: (id) => inv('projects:remove', id),
  listModels: (id) => inv('models:list', id),
  send: (a) => inv('chat:send', a),
  stop: (id) => inv('chat:stop', id),
  compactChat: (convId) => inv('chat:compact', convId),
  respond: (id, allow) => inv('approval:respond', id, allow),
  mcpStatus: () => inv('mcp:status'),
  subsStatus: () => inv('subs:status'),
  subsLogin: (which) => inv('subs:login', which),
  subsSubmitCode: (code) => inv('subs:submit', code),
  subsLogout: (which) => inv('subs:logout', which),
  usageGet: () => inv('usage:get'),
  voiceTranscribe: (bytes) => inv('voice:transcribe', bytes),
  imagesNormalize: (bytes) => inv('images:normalize', bytes),
  extractFile: (name, kind, dataBase64) => inv('files:extract', { name, kind, dataBase64 }),
  voiceStatus: () => inv('voice:status'),
  voiceDownloadModel: () => inv('voice:download-model'),
  onVoiceModelProgress: (cb) => {
    const h = (_: unknown, e: { pct: number }) => cb(e)
    ipcRenderer.on('voice:model-progress', h)
    return () => ipcRenderer.removeListener('voice:model-progress', h)
  },
  pickDir: () => inv('dialog:dir'),
  onEvent: (cb) => {
    const h = (_: unknown, e: ChatEvent) => cb(e)
    ipcRenderer.on('chat:event', h)
    return () => ipcRenderer.removeListener('chat:event', h)
  },
  onSubsAuth: (cb) => {
    const h = (_: unknown, e: SubsAuthEvent) => cb(e)
    ipcRenderer.on('subs:auth', h)
    return () => ipcRenderer.removeListener('subs:auth', h)
  },
  onSubsDone: (cb) => {
    const h = (_: unknown, e: SubsDoneEvent) => cb(e)
    ipcRenderer.on('subs:done', h)
    return () => ipcRenderer.removeListener('subs:done', h)
  }
}
contextBridge.exposeInMainWorld('api', api)
