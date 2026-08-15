import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { DashboardSnapshot } from './contracts.js'

export const DEFAULT_STATE_FILE = join(homedir(), '.dsh', 'dsh-traffic-light', 'state.json')

export function resolveStateFilePath(configuredPath: string): string {
  const value = configuredPath.trim()
  if (value.length === 0) return DEFAULT_STATE_FILE
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

/**
 * Serializes snapshots and replaces the destination atomically. The desktop
 * process therefore never observes a half-written JSON document.
 */
export class StateFilePublisher {
  private tail = Promise.resolve()

  constructor(
    readonly path: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  publish(snapshot: DashboardSnapshot, online = true): Promise<void> {
    const payload: DashboardSnapshot = {
      ...snapshot,
      generatedAt: Date.now(),
      online,
    }
    this.tail = this.tail
      .then(() => this.write(payload))
      .catch((error: unknown) => { this.onError(error) })
    return this.tail
  }

  private async write(snapshot: DashboardSnapshot): Promise<void> {
    const directory = dirname(this.path)
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, this.path)
  }
}
