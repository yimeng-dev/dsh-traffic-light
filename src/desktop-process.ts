import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

export interface DesktopProcessLogger {
  warn(message: string, error?: unknown): void
}

/** Owns at most one Electron child. Electron's single-instance lock is the cross-process guard. */
export class DesktopProcessController {
  private child: ChildProcess | undefined
  private startTask: Promise<void> | undefined
  private runtimePreparationTask: Promise<void> | undefined
  private runtimePreparationAbort: AbortController | undefined
  private runtimePrepared = false
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

  /**
   * Starts Electron's installer in a separate Node process.  DSH can install
   * plugins with dependency lifecycle scripts disabled, which otherwise moves
   * Electron's large first-run download into the first menu click.  Keeping
   * the work in a child lets the Host stay responsive while it is prepared.
   */
  prewarmRuntime(): Promise<void> {
    if (this.configuredExecutable.trim().length > 0 || this.runtimePrepared) {
      return Promise.resolve()
    }
    if (this.runtimePreparationTask !== undefined) return this.runtimePreparationTask

    const abort = new AbortController()
    this.runtimePreparationAbort = abort
    this.runtimePreparationTask = prepareElectronRuntime(this.projectRoot, abort.signal)
      .then(() => { this.runtimePrepared = true })
      .catch(error => {
        if (!abort.signal.aborted) {
          this.logger.warn('Failed to prepare the Electron desktop runtime in the background', error)
        }
      })
      .finally(() => {
        this.runtimePreparationTask = undefined
        if (this.runtimePreparationAbort === abort) this.runtimePreparationAbort = undefined
      })
    return this.runtimePreparationTask
  }

  dispose(): void {
    this.desired = false
    this.stopChild()
    this.runtimePreparationAbort?.abort()
    this.runtimePreparationAbort = undefined
  }

  private async start(): Promise<void> {
    // If the background preparation is still running, share it rather than
    // racing two Electron installers against the same dist/ directory.
    await this.prewarmRuntime()
    if (!this.desired) return

    let executable: string
    try {
      executable = resolveDesktopExecutable(this.configuredExecutable, this.projectRoot)
    } catch (error) {
      this.logger.warn('Failed to resolve the Electron desktop runtime', error)
      return
    }
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

/**
 * Run Electron's own installer without loading the Electron package in the
 * Host process.  Loading `require('electron')` when its binary is missing
 * uses spawnSync internally and would block the HTTP request that toggles a
 * light.  The child does the same work asynchronously instead.
 */
export async function prepareElectronRuntime(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('Electron runtime preparation was cancelled')
  const projectRequire = createRequire(join(projectRoot, 'package.json'))
  const installer = projectRequire.resolve('electron/install.js')

  return new Promise((resolvePreparation, rejectPreparation) => {
    const child = spawn(process.execPath, [installer], {
      env: { ...process.env },
      stdio: 'ignore',
      windowsHide: true,
    })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      if (error === undefined) resolvePreparation()
      else rejectPreparation(error)
    }
    const cancel = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // The process can already be gone; its close listener will settle.
      }
      finish(new Error('Electron runtime preparation was cancelled'))
    }

    child.once('error', error => { finish(error) })
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      const detail = signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`
      finish(new Error(`Electron runtime installer exited with ${detail}`))
    })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

export function resolveDesktopExecutable(configuredPath: string, projectRoot: string): string {
  const value = configuredPath.trim()
  if (value.length > 0) {
    if (value === '~') return homedir()
    if (value.startsWith('~/')) return join(homedir(), value.slice(2))
    return isAbsolute(value) ? value : resolve(value)
  }

  // Loading the Electron package is intentional here.  DSH installs plugin
  // dependencies without lifecycle scripts in some environments, so the
  // Electron postinstall hook may not have downloaded its platform runtime.
  // Electron's own entry point detects that situation and runs install.js
  // before returning the actual executable path.  This also preserves
  // ELECTRON_OVERRIDE_DIST_PATH for users who provide a custom runtime.
  const projectRequire = createRequire(join(projectRoot, 'package.json'))
  const executable = projectRequire('electron')
  if (typeof executable !== 'string' || executable.trim().length === 0) {
    throw new Error('The Electron package did not return an executable path')
  }
  return executable.trim()
}
