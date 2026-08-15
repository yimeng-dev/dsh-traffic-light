import type { DashboardSnapshot, SessionView, TrafficState } from '../../src/contracts'

const NOW = Date.now()

const demoRows: Array<{
  name: string
  id: string
  cwd: string
  state: TrafficState
  elapsed: number
  detail: string
  lastEvent: string
}> = [
  {
    name: 'inventory-agent',
    id: 'a1b2c3d4',
    cwd: '~/projects/inventory-agent',
    state: 'running',
    elapsed: 12 * 60 + 34,
    detail: 'Agent driver is active',
    lastEvent: 'agent/status',
  },
  {
    name: 'release-review',
    id: 'b2c3d4e5',
    cwd: '~/projects/release-review',
    state: 'attention',
    elapsed: 68,
    detail: 'Waiting for an approval decision',
    lastEvent: 'approval/asked',
  },
  {
    name: 'docs-migration',
    id: 'c3d4e5f6',
    cwd: '~/projects/docs-migration',
    state: 'completed',
    elapsed: 1 * 60 * 60 + 45 * 60 + 22,
    detail: 'Turn completed successfully',
    lastEvent: 'turn/end',
  },
  {
    name: 'api-smoke-test',
    id: 'd4e5f6a7',
    cwd: '~/projects/api-smoke-test',
    state: 'failed',
    elapsed: 3 * 60 + 51,
    detail: 'Agent exited with an unrecoverable error',
    lastEvent: 'agent/error',
  },
  {
    name: 'sandbox',
    id: 'e5f6a7b8',
    cwd: '~/sandbox',
    state: 'idle',
    elapsed: 25 * 60 + 47,
    detail: 'No active agent driver',
    lastEvent: 'agent/status',
  },
]

export const demoSnapshot: DashboardSnapshot = {
  version: 1,
  generatedAt: NOW,
  aggregate: 'attention',
  sessions: demoRows.map<SessionView>((row) => ({
    id: row.id,
    shortId: row.id,
    name: row.name,
    cwd: row.cwd,
    createdAt: NOW - row.elapsed * 1_000,
    agentLive: row.state === 'running' || row.state === 'attention',
    sessionLive: true,
    driverStatus: row.state === 'running' || row.state === 'attention' ? 'running' : 'idle',
    state: row.state,
    stateSince: NOW - row.elapsed * 1_000,
    detail: row.detail,
    lastEvent: row.lastEvent,
  })),
}
