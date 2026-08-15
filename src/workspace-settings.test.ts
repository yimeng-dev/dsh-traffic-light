import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceSettingsStore } from './workspace-settings.js'

const workspaces = [
  { id: 'workspace-a', path: '/projects/a', title: 'A' },
  { id: 'workspace-b', path: '/projects/b', title: 'B' },
]

describe('WorkspaceSettingsStore', () => {
  it('persists workspace ids privately and restores them for a new process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-settings-'))
    const path = join(directory, 'nested', 'settings.json')
    const first = new WorkspaceSettingsStore(path)

    await first.setEnabled('workspace-b', true)
    expect(first.snapshot(workspaces).workspaces).toEqual([
      { id: 'workspace-a', title: 'A', enabled: false },
      { id: 'workspace-b', title: 'B', enabled: true },
    ])
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      enabledWorkspaceIds: string[]
    }
    expect(persisted.enabledWorkspaceIds).toEqual(['workspace-b'])

    const restored = new WorkspaceSettingsStore(path)
    await restored.ready
    expect(restored.isEnabled('workspace-b')).toBe(true)
  })

  it('serializes concurrent toggles without losing a workspace selection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-settings-'))
    const store = new WorkspaceSettingsStore(join(directory, 'settings.json'))

    await Promise.all([
      store.setEnabled('workspace-a', true),
      store.setEnabled('workspace-b', true),
    ])
    expect(new Set(store.enabledIds())).toEqual(new Set(['workspace-a', 'workspace-b']))
  })
})
