/** The five product states represented by three physical lamps plus motion/off. */
export type TrafficState = 'running' | 'attention' | 'completed' | 'failed' | 'idle'

export type AgentDriverStatus = 'running' | 'idle'

export interface SessionView {
  id: string
  shortId: string
  name: string
  cwd?: string
  createdAt: number
  parentSession?: string
  origin?: 'subagent'
  agentLive: boolean
  sessionLive: boolean
  driverStatus: AgentDriverStatus
  state: TrafficState
  stateSince: number
  detail: string
  lastEvent?: string
}

export interface DashboardSnapshot {
  version: 1
  generatedAt: number
  aggregate: TrafficState
  sessions: SessionView[]
  /** Present in the desktop state file; omitted from the HTTP debug API. */
  online?: boolean
  /** Stable official Workspace ids selected through the DSH sidebar. */
  enabledWorkspaceIds?: string[]
  /** Canonical official Workspace paths used by the desktop process to filter Sessions. */
  enabledWorkspacePaths?: string[]
  /** Stable Session ids selected through the DSH sidebar. */
  enabledSessionIds?: string[]
}
