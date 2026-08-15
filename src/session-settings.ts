import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface SessionSwitchView {
  id: string
  label: string
  shortId: string
  enabled: boolean
  visible: boolean
}

export interface SessionSwitchGroup {
  id: string
  title: string
  sessions: SessionSwitchView[]
}

export interface SessionSwitchSnapshot {
  version: 2
  groups: SessionSwitchGroup[]
  flatSessions: SessionSwitchView[]
}

interface PersistedSessionSettings {
  version: 2
  enabledSessionIds: string[]
}

interface LegacyWorkspaceSettings {
  version: 1
  enabledWorkspaceIds: string[]
}

export const DEFAULT_SESSION_SETTINGS_FILE = join(
  homedir(),
  '.dsh',
  'dsh-traffic-light',
  'settings.json',
)

export function resolveSessionSettingsFilePath(configuredPath: string): string {
  const value = configuredPath.trim()
  if (value.length === 0) return DEFAULT_SESSION_SETTINGS_FILE
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

/** Server-side selection of individual Session towers. */
export class SessionSettingsStore {
  private enabled = new Set<string>()
  private legacyWorkspaceIds = new Set<string>()
  private tail = Promise.resolve()
  readonly ready: Promise<void>

  constructor(
    readonly path: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.ready = this.load()
  }

  enabledIds(): string[] {
    return [...this.enabled]
  }

  snapshot(groups: SessionSwitchGroup[]): SessionSwitchSnapshot {
    const flatSessions = groups.flatMap(group => group.sessions)
    return { version: 2, groups, flatSessions }
  }

  setEnabled(sessionId: string, enabled: boolean): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.ready
      const next = new Set(this.enabled)
      if (enabled) next.add(sessionId)
      else next.delete(sessionId)
      await this.write(next)
      this.enabled = next
    })
    this.tail = operation.catch(() => {})
    return operation.catch((error: unknown) => {
      this.onError(error)
      throw error
    })
  }

  /** Re-read settings changed by the companion desktop process. */
  reload(): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.ready
      await this.load()
    })
    this.tail = operation.catch(() => {})
    return operation.catch((error: unknown) => {
      this.onError(error)
      throw error
    })
  }

  migrateLegacyWorkspaceIds(workspaces: readonly {
    id: string
    sessionIds?: readonly string[]
  }[]): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.ready
      if (this.legacyWorkspaceIds.size === 0) return
      const next = new Set(this.enabled)
      for (const workspace of workspaces) {
        if (!this.legacyWorkspaceIds.has(workspace.id)) continue
        for (const sessionId of workspace.sessionIds ?? []) next.add(String(sessionId))
      }
      await this.write(next)
      this.enabled = next
      this.legacyWorkspaceIds.clear()
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
      if (isPersistedSessionSettings(parsed)) {
        this.enabled = new Set(parsed.enabledSessionIds)
        this.legacyWorkspaceIds.clear()
      } else if (isLegacyWorkspaceSettings(parsed)) {
        this.enabled.clear()
        this.legacyWorkspaceIds = new Set(parsed.enabledWorkspaceIds)
      }
    } catch (error) {
      if (isMissingFile(error)) return
      this.onError(error)
    }
  }

  private async write(enabled: ReadonlySet<string>): Promise<void> {
    const directory = dirname(this.path)
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    const value: PersistedSessionSettings = {
      version: 2,
      enabledSessionIds: [...enabled],
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.path)
  }
}

function isPersistedSessionSettings(value: unknown): value is PersistedSessionSettings {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedSessionSettings>
  return candidate.version === 2
    && Array.isArray(candidate.enabledSessionIds)
    && candidate.enabledSessionIds.every(id => typeof id === 'string' && id.length > 0)
}

function isLegacyWorkspaceSettings(value: unknown): value is LegacyWorkspaceSettings {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<LegacyWorkspaceSettings>
  return candidate.version === 1
    && Array.isArray(candidate.enabledWorkspaceIds)
    && candidate.enabledWorkspaceIds.every(id => typeof id === 'string' && id.length > 0)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
