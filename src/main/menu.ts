import { Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

// The application menu is not decoration: on macOS the Edit menu's roles
// are what wire Cmd+X/C/V/A into text fields at the OS level. Without any
// menu (this app shipped with none) paste into the composer was unreliable
// to broken. Roles keep the accelerators and labels native per platform.
export function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    // macOS app menu: About Koshirae AI / Hide / Quit (the role supplies
    // the app name and standard items).
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Right-click menu. The app is heavy on text fields (composer, settings),
// so an editable target gets the editing roles gated on what Chromium says
// is possible there; a plain text selection elsewhere gets Copy. Anything
// else gets no menu at all — the webContents default is no menu, so silence
// is the old behavior, kept.
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' })
    }
    if (!items.length) return
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}
