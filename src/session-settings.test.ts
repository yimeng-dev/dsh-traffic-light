import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSettingsStore } from './session-settings.js'

describe('SessionSettingsStore', () => {
  it('migrates legacy workspace selections into Session ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-session-settings-'))
    const path = join(directory, 'settings.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      enabledWorkspaceIds: ['workspace-a'],
    }))
    const store = new SessionSettingsStore(path)

    await store.migrateLegacyWorkspaceIds([
      { id: 'workspace-a', sessionIds: ['session-1', 'session-2'] },
      { id: 'workspace-b', sessionIds: ['session-3'] },
    ])

    expect(store.enabledIds()).toEqual(['session-1', 'session-2'])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 2,
      enabledSessionIds: ['session-1', 'session-2'],
    })
  })

  it('serializes independent Session toggles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-session-settings-'))
    const store = new SessionSettingsStore(join(directory, 'settings.json'))

    await Promise.all([
      store.setEnabled('session-a', true),
      store.setEnabled('session-b', true),
    ])
    expect(new Set(store.enabledIds())).toEqual(new Set(['session-a', 'session-b']))
  })

  it('reloads a Session selection changed by the desktop process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-session-settings-'))
    const path = join(directory, 'settings.json')
    const store = new SessionSettingsStore(path)
    await store.setEnabled('session-a', true)

    await writeFile(path, JSON.stringify({
      version: 2,
      enabledSessionIds: ['session-b'],
    }))
    await store.reload()

    expect(store.enabledIds()).toEqual(['session-b'])
  })
})
