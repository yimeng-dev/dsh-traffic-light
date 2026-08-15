import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DashboardSnapshot } from './contracts.js'
import { resolveStateFilePath, StateFilePublisher } from './state-file.js'

const emptySnapshot: DashboardSnapshot = {
  version: 1,
  generatedAt: 1,
  aggregate: 'idle',
  sessions: [],
}

describe('StateFilePublisher', () => {
  it('writes a private, complete snapshot and marks host availability', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-'))
    const path = join(directory, 'nested', 'state.json')
    const publisher = new StateFilePublisher(path)

    await publisher.publish({
      ...emptySnapshot,
      enabledWorkspaceIds: ['workspace-a'],
      enabledWorkspacePaths: ['/projects/a'],
    })
    const online = JSON.parse(await readFile(path, 'utf8')) as DashboardSnapshot
    expect(online.online).toBe(true)
    expect(online.aggregate).toBe('idle')
    expect(online.enabledWorkspacePaths).toEqual(['/projects/a'])
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await publisher.publish({ ...emptySnapshot, aggregate: 'failed' }, false)
    const offline = JSON.parse(await readFile(path, 'utf8')) as DashboardSnapshot
    expect(offline.online).toBe(false)
    expect(offline.aggregate).toBe('failed')
  })

  it('keeps absolute configured paths unchanged', () => {
    expect(resolveStateFilePath('/tmp/custom-state.json')).toBe('/tmp/custom-state.json')
  })
})
