import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const nodeRequire = createRequire(import.meta.url)

export interface DesktopProcessLogger {
  warn(message: string, error?: unknown): void
}

/** Owns at most one Electron child. Electron's single-instance lock is the cross-process guard. */
export class DesktopProcessController {
  private child: ChildProcess | undefined
  private startTask: Promise<void> | undefined
  private desired = false

  constructor(
    private readonly projectRoot: string,
    private readonly stateFile: string,
    private readonly settingsFile: string,
    private readonly configuredExecutable: string,
    private readonly logger: DesktopProcessLogger,
  ) {}

  setDesiredRunning(desired: boolean): Promise<void> {
    this.desired = desired
    if (!desired) {
      this.stopChild()
      return Promise.resolve()
    }
    if (this.child !== undefined && this.child.exitCode === null && !this.child.killed) {
      return Promise.resolve()
    }
    if (this.startTask !== undefined) return this.startTask
    this.startTask = this.start().finally(() => { this.startTask = undefined })
    return this.startTask
  }

  private async start(): Promise<void> {
    const executable = resolveDesktopExecutable(this.configuredExecutable, this.projectRoot)
    try {
      await access(executable, constants.X_OK)
    } catch (error) {
      this.logger.warn(`Desktop executable is unavailable: ${executable}`, error)
      return
    }
    if (!this.desired) return

    // The published package contains only dist/.  Launch the compiled entry
    // directly so it does not depend on the development-only desktop/
    // package.json wrapper.
    const desktopEntry = join(this.projectRoot, 'dist', 'desktop', 'main.js')
    try {
      await access(desktopEntry, constants.R_OK)
    } catch (error) {
      this.logger.warn(`Desktop entry is unavailable: ${desktopEntry}`, error)
      return
    }
    const environment = { ...process.env }
    // The packaged DSH desktop runs its Host child with Electron's Node mode.
    // Carrying this flag into our child would make the Electron executable act
    // like plain Node and exit before app.whenReady().
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, [
      desktopEntry,
      `--state-file=${this.stateFile}`,
      `--settings-file=${this.settingsFile}`,
    ], {
      env: environment,
      stdio: 'ignore',
      windowsHide: true,
    })
    this.child = child
    child.once('error', error => {
      if (this.child === child) this.child = undefined
      this.logger.warn('Failed to start the traffic-light desktop process', error)
    })
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
    })
  }

  private stopChild(): void {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null || child.killed) return
    child.kill('SIGTERM')
  }
}

export function resolveDesktopExecutable(configuredPath: string, projectRoot: string): string {
  const value = configuredPath.trim()
  if (value.length > 0) {
    if (value === '~') return homedir()
    if (value.startsWith('~/')) return join(homedir(), value.slice(2))
    return isAbsolute(value) ? value : resolve(value)
  }
  const electronRoot = resolveElectronPackageRoot(projectRoot)
  if (process.platform === 'darwin') {
    return join(
      electronRoot,
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron',
    )
  }
  return join(
    electronRoot,
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  )
}

function resolveElectronPackageRoot(projectRoot: string): string {
  try {
    return dirname(nodeRequire.resolve('electron/package.json', { paths: [projectRoot] }))
  } catch {
    // Keep the legacy path as a useful diagnostic/fallback for a manually
    // configured development checkout.
    return join(projectRoot, 'node_modules', 'electron')
  }
}
