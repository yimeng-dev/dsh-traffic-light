import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface WorkspaceRecord {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds?: readonly string[]
}

export interface WorkspaceRegistryPort {
  list(): readonly WorkspaceRecord[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistryPort
  }
}

interface PersistedWorkspaceSettings {
  version: 1
  enabledWorkspaceIds: string[]
}

export interface WorkspaceSwitchView {
  id: string
  title: string
  enabled: boolean
}

export interface WorkspaceSwitchSnapshot {
  version: 1
  workspaces: WorkspaceSwitchView[]
}

export const DEFAULT_SETTINGS_FILE = join(
  homedir(),
  '.dsh',
  'dsh-traffic-light',
  'settings.json',
)

export function resolveSettingsFilePath(configuredPath: string): string {
  const value = configuredPath.trim()
  if (value.length === 0) return DEFAULT_SETTINGS_FILE
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

/** Durable, server-side workspace selection shared by every DSH browser tab. */
export class WorkspaceSettingsStore {
  private enabled = new Set<string>()
  private tail = Promise.resolve()
  readonly ready: Promise<void>

  constructor(
    readonly path: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.ready = this.load()
  }

  isEnabled(workspaceId: string): boolean {
    return this.enabled.has(workspaceId)
  }

  enabledIds(): string[] {
    return [...this.enabled]
  }

  snapshot(workspaces: readonly WorkspaceRecord[]): WorkspaceSwitchSnapshot {
    return {
      version: 1,
      workspaces: workspaces.map(workspace => ({
        id: workspace.id,
        title: workspace.title,
        enabled: this.enabled.has(workspace.id),
      })),
    }
  }

  setEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.ready
      const next = new Set(this.enabled)
      if (enabled) next.add(workspaceId)
      else next.delete(workspaceId)
      await this.write(next)
      this.enabled = next
    })
    this.tail = operation.catch(() => {})
    return operation.catch((error: unknown) => {
      this.onError(error)
      throw error
    })
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!isPersistedSettings(parsed)) throw new Error('unsupported workspace settings file')
      this.enabled = new Set(parsed.enabledWorkspaceIds)
    } catch (error) {
      if (isMissingFile(error)) return
      this.onError(error)
    }
  }

  private async write(enabled: ReadonlySet<string>): Promise<void> {
    const directory = dirname(this.path)
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    const value: PersistedWorkspaceSettings = {
      version: 1,
      enabledWorkspaceIds: [...enabled],
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.path)
  }
}

function isPersistedSettings(value: unknown): value is PersistedWorkspaceSettings {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedWorkspaceSettings>
  return candidate.version === 1
    && Array.isArray(candidate.enabledWorkspaceIds)
    && candidate.enabledWorkspaceIds.every(id => typeof id === 'string' && id.length > 0)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
