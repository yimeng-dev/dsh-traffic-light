export type TrafficState = 'running' | 'attention' | 'completed' | 'failed' | 'idle'

export interface SessionView {
  id: string
  shortId: string
  name: string
  cwd?: string
  createdAt: number
  agentLive: boolean
  sessionLive: boolean
  driverStatus: 'running' | 'idle'
  state: TrafficState
  stateSince: number
  detail: string
}

export interface DashboardSnapshot {
  version: 1
  generatedAt: number
  aggregate: TrafficState
  sessions: SessionView[]
  online?: boolean
  enabledWorkspaceIds?: string[]
  enabledWorkspacePaths?: string[]
  enabledSessionIds?: string[]
}
