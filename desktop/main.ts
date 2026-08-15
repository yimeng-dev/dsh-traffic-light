import { watch, type FSWatcher } from 'node:fs'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron'
import type { DashboardSnapshot, SessionView, TrafficState } from './contracts.js'

const WINDOW_WIDTH = 126
const WINDOW_HEIGHT = 352
const WINDOW_GAP = 10
const SCREEN_MARGIN = 18
const STALE_AFTER_MS = 15_000
const desktopDirectory = dirname(fileURLToPath(import.meta.url))
const rendererPath = resolve(desktopDirectory, '../web/index.html')
const preloadPath = resolve(desktopDirectory, 'preload.cjs')
const stateFilePath = stateFileFromArguments()
const settingsFilePath = settingsFileFromArguments()
const desktopProfilePath = join(dirname(stateFilePath), 'desktop-profile')

interface DesktopSnapshotMessage {
  connected: boolean
  snapshot: DashboardSnapshot | null
}

interface PersistedSessionSettings {
  version: 2
  enabledSessionIds: string[]
}

const windows = new Map<string, BrowserWindow>()
let latestMessage: DesktopSnapshotMessage = { connected: false, snapshot: null }
let stateWatcher: FSWatcher | undefined
let pollTimer: NodeJS.Timeout | undefined
let quitting = false
let selectionKey: string | undefined
const locallyClosedSessions = new Set<string>()

app.setPath('userData', desktopProfilePath)
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    for (const window of windows.values()) window.showInactive()
  })

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      app.dock?.hide()
      app.setActivationPolicy('accessory')
    }

    ipcMain.on('traffic-light:ready', event => {
      event.sender.send('traffic-light:snapshot', latestMessage)
    })
    ipcMain.on('traffic-light:close-session', event => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (window === null) return
      const sessionId = [...windows.entries()].find(([, candidate]) => candidate === window)?.[0]
      if (sessionId === undefined) return
      closeSessionWindow(sessionId)
    })
    ipcMain.on('traffic-light:quit', () => { app.quit() })

    await mkdir(dirname(stateFilePath), { recursive: true, mode: 0o700 })
    await refreshState()
    startWatchingStateFile()
  }).catch(error => {
    console.error('[dsh-traffic-light] desktop startup failed', error)
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    stateWatcher?.close()
    if (pollTimer !== undefined) clearInterval(pollTimer)
  })

  app.on('window-all-closed', () => {
    if (quitting) return
    syncWindows(latestMessage.snapshot)
  })
}

function startWatchingStateFile(): void {
  const directory = dirname(stateFilePath)
  stateWatcher = watch(directory, { persistent: false }, (_event, filename) => {
    if (filename === null || filename.toString() === basename(stateFilePath)) {
      void refreshState()
    }
  })
  pollTimer = setInterval(() => { void refreshState() }, 2_000)
}

async function refreshState(): Promise<void> {
  try {
    const [body, info] = await Promise.all([
      readFile(stateFilePath, 'utf8'),
      stat(stateFilePath),
    ])
    const snapshot = parseSnapshot(JSON.parse(body) as unknown)
    const nextSelectionKey = JSON.stringify(
      snapshot.enabledSessionIds ?? snapshot.enabledWorkspacePaths ?? null,
    )
    if (selectionKey !== undefined && selectionKey !== nextSelectionKey) {
      locallyClosedSessions.clear()
    }
    selectionKey = nextSelectionKey
    latestMessage = {
      connected: snapshot.online !== false && Date.now() - info.mtimeMs <= STALE_AFTER_MS,
      snapshot,
    }
  } catch {
    latestMessage = { connected: false, snapshot: null }
  }

  syncWindows(latestMessage.snapshot)
  for (const window of windows.values()) {
    if (!window.isDestroyed()) window.webContents.send('traffic-light:snapshot', latestMessage)
  }
}

function syncWindows(snapshot: DashboardSnapshot | null): void {
  const sessions = visibleSessions(snapshot).filter(session => !locallyClosedSessions.has(session.id))
  const usesSelection = snapshot?.enabledSessionIds !== undefined
    || snapshot?.enabledWorkspacePaths !== undefined
  const targets = sessions.length === 0 && !usesSelection
    ? [{ id: '__host__', name: 'DSH' }]
    : sessions.map(session => ({ id: session.id, name: session.name }))
  const targetIds = new Set(targets.map(target => target.id))

  for (const [id, window] of windows) {
    if (targetIds.has(id)) continue
    windows.delete(id)
    window.destroy()
  }

  targets.forEach((target, index) => {
    const current = windows.get(target.id)
    if (current !== undefined && !current.isDestroyed()) return
    const window = createTrafficWindow(target.id, target.name, index)
    windows.set(target.id, window)
  })
}

function visibleSessions(snapshot: DashboardSnapshot | null): SessionView[] {
  if (snapshot === null) return []
  if (snapshot.enabledSessionIds !== undefined) {
    const enabledIds = new Set(snapshot.enabledSessionIds)
    return snapshot.sessions.filter(session => enabledIds.has(session.id))
  }
  if (snapshot.enabledWorkspacePaths === undefined) return snapshot.sessions
  const enabledPaths = new Set(snapshot.enabledWorkspacePaths)
  return snapshot.sessions.filter(session => session.cwd !== undefined && enabledPaths.has(session.cwd))
}

function createTrafficWindow(sessionId: string, title: string, index: number): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
  })

  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.setPosition(...initialPosition(index))
  void window.loadFile(rendererPath, {
    query: { surface: 'desktop', session: sessionId },
  }).then(() => {
    window.webContents.send('traffic-light:snapshot', latestMessage)
    window.showInactive()
  }).catch(error => {
    console.error('[dsh-traffic-light] renderer failed to load', error)
  })

  window.on('closed', () => {
    if (windows.get(sessionId) === window) windows.delete(sessionId)
  })
  window.webContents.on('context-menu', event => {
    event.preventDefault()
    const label = sessionId === '__host__'
      ? '退出 DSH 红绿灯'
      : '关闭悬浮灯'
    const menu = Menu.buildFromTemplate([
      {
        label,
        click: () => {
          void disableSessionSelection(sessionId)
          closeSessionWindow(sessionId)
        },
      },
    ])
    menu.popup({ window })
  })
  return window
}

function closeSessionWindow(sessionId: string): void {
  const window = windows.get(sessionId)
  if (window === undefined || window.isDestroyed()) return
  if (sessionId === '__host__') {
    app.quit()
    return
  }
  locallyClosedSessions.add(sessionId)
  windows.delete(sessionId)
  window.destroy()
}

async function disableSessionSelection(sessionId: string): Promise<void> {
  if (sessionId === '__host__') return
  try {
    const parsed = JSON.parse(await readFile(settingsFilePath, 'utf8')) as unknown
    if (!isSessionSettings(parsed)) return
    const enabledSessionIds = parsed.enabledSessionIds.filter(id => id !== sessionId)
    if (enabledSessionIds.length === parsed.enabledSessionIds.length) return

    const temporaryPath = `${settingsFilePath}.${process.pid}.tmp`
    await mkdir(dirname(settingsFilePath), { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, `${JSON.stringify({
      version: 2,
      enabledSessionIds,
    }, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, settingsFilePath)
  } catch (error) {
    console.error('[dsh-traffic-light] failed to disable Session after context-menu close', error)
  }
}

function initialPosition(index: number): [number, number] {
  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea
  const columns = Math.max(1, Math.floor((width - SCREEN_MARGIN * 2) / (WINDOW_WIDTH + WINDOW_GAP)))
  const column = index % columns
  const row = Math.floor(index / columns)
  const targetX = x + width - SCREEN_MARGIN - WINDOW_WIDTH - column * (WINDOW_WIDTH + WINDOW_GAP)
  const targetY = Math.min(
    y + SCREEN_MARGIN + row * (WINDOW_HEIGHT + WINDOW_GAP),
    y + height - SCREEN_MARGIN - WINDOW_HEIGHT,
  )
  return [Math.round(targetX), Math.round(targetY)]
}

function stateFileFromArguments(): string {
  const prefix = '--state-file='
  const argument = process.argv.find(value => value.startsWith(prefix))
  if (argument !== undefined) return resolve(argument.slice(prefix.length))
  return join(homedir(), '.dsh', 'dsh-traffic-light', 'state.json')
}

function settingsFileFromArguments(): string {
  const prefix = '--settings-file='
  const argument = process.argv.find(value => value.startsWith(prefix))
  if (argument !== undefined) return resolve(argument.slice(prefix.length))
  return join(dirname(stateFilePath), 'settings.json')
}

function isSessionSettings(value: unknown): value is PersistedSessionSettings {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedSessionSettings>
  return candidate.version === 2
    && Array.isArray(candidate.enabledSessionIds)
    && candidate.enabledSessionIds.every(id => typeof id === 'string' && id.length > 0)
}

function parseSnapshot(value: unknown): DashboardSnapshot {
  if (value === null || typeof value !== 'object') throw new Error('snapshot must be an object')
  const candidate = value as Partial<DashboardSnapshot>
  if (candidate.version !== 1 || !isTrafficState(candidate.aggregate) || !Array.isArray(candidate.sessions)) {
    throw new Error('unsupported snapshot')
  }
  if (!candidate.sessions.every(isSessionView)) throw new Error('invalid session list')
  return candidate as DashboardSnapshot
}

function isSessionView(value: unknown): value is SessionView {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<SessionView>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && isTrafficState(candidate.state)
    && typeof candidate.detail === 'string'
}

function isTrafficState(value: unknown): value is TrafficState {
  return value === 'running'
    || value === 'attention'
    || value === 'completed'
    || value === 'failed'
    || value === 'idle'
}
