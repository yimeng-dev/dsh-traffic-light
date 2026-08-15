import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {
  AgentDriverStatus,
  DashboardSnapshot,
  SessionView,
  TrafficState,
} from './contracts.js'

export interface SessionRegistration {
  id: string
  cwd?: string
  createdAt?: number
  parentSession?: string
  origin?: 'subagent'
  agentLive?: boolean
  sessionLive?: boolean
  driverStatus?: AgentDriverStatus
}

interface TerminalState {
  state: Extract<TrafficState, 'attention' | 'completed' | 'failed'>
  since: number
  detail: string
  expiresAt?: number
}

interface MutableSession {
  id: string
  name: string
  cwd?: string
  createdAt: number
  parentSession?: string
  origin?: 'subagent'
  agentLive: boolean
  sessionLive: boolean
  driverStatus: AgentDriverStatus
  activeApprovals: Set<string>
  activeQuestions: Set<string>
  terminal?: TerminalState
  state: TrafficState
  stateSince: number
  detail: string
  lastEvent?: string
  lastSeq: number
}

type SnapshotListener = (snapshot: DashboardSnapshot) => void

const PRIORITY: Record<TrafficState, number> = {
  failed: 5,
  attention: 4,
  running: 3,
  completed: 2,
  idle: 1,
}

/**
 * Pure in-memory projection from official DSH lifecycle/session events to the
 * five product states. DSH-specific listening stays in index.ts so breaking
 * upstream API changes are contained at one adapter boundary.
 */
export class TrafficLightStore {
  private readonly records = new Map<string, MutableSession>()
  private readonly listeners = new Set<SnapshotListener>()

  constructor(private readonly completedHoldMs: number) {}

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  ingestSession(
    registration: SessionRegistration,
    events: readonly SessionEvent[],
    now = Date.now(),
  ): void {
    const record = this.upsert(registration, now)
    record.activeApprovals.clear()
    record.activeQuestions.clear()
    delete record.terminal
    delete record.lastEvent
    record.lastSeq = -1

    for (const event of events) this.applyEvent(record, event)
    this.recompute(record, now)
    this.publish()
  }

  registerSession(registration: SessionRegistration, now = Date.now()): void {
    const record = this.upsert(registration, now)
    this.recompute(record, now)
    this.publish()
  }

  recordSessionEvent(id: string, event: SessionEvent, now = Date.now()): void {
    const record = this.upsert({ id, sessionLive: true }, now)
    if (event.seq <= record.lastSeq) return
    this.applyEvent(record, event)
    this.recompute(record, now)
    this.publish()
  }

  setAgentStatus(id: string, status: AgentDriverStatus, now = Date.now()): void {
    const record = this.upsert({ id, agentLive: true, driverStatus: status }, now)
    record.lastEvent = 'agent/status'
    if (status === 'running') {
      delete record.terminal
    }
    this.recompute(record, now)
    this.publish()
  }

  markAgentCreated(registration: SessionRegistration, now = Date.now()): void {
    const record = this.upsert({ ...registration, agentLive: true }, now)
    record.lastEvent = 'agent/created'
    this.recompute(record, now)
    this.publish()
  }

  markAgentDisposed(id: string, now = Date.now()): void {
    const record = this.records.get(id)
    if (record === undefined) return
    record.agentLive = false
    record.driverStatus = 'idle'
    record.lastEvent = 'agent/disposed'
    this.recompute(record, now)
    this.publish()
  }

  recordAgentError(id: string, error: unknown, now = Date.now()): void {
    const record = this.upsert({ id }, now)
    record.activeApprovals.clear()
    record.activeQuestions.clear()
    record.terminal = {
      state: 'failed',
      since: now,
      detail: describeError(error),
    }
    record.lastEvent = 'agent/error'
    this.recompute(record, now)
    this.publish()
  }

  recordConfigStartFailure(id: string, error: unknown, now = Date.now()): void {
    const record = this.upsert({ id, agentLive: false, sessionLive: false }, now)
    record.terminal = {
      state: 'failed',
      since: now,
      detail: `Agent startup failed: ${describeError(error)}`,
    }
    record.lastEvent = 'agent-loop/config-start-failed'
    this.recompute(record, now)
    this.publish()
  }

  removeSession(id: string): void {
    if (!this.records.delete(id)) return
    this.publish()
  }

  resetTerminalStates(now = Date.now()): void {
    for (const record of this.records.values()) {
      delete record.terminal
      this.recompute(record, now)
    }
    this.publish()
  }

  sweep(now = Date.now()): void {
    let changed = false
    for (const record of this.records.values()) {
      if (record.terminal?.state !== 'completed') continue
      if (record.terminal.expiresAt === undefined || record.terminal.expiresAt > now) continue
      delete record.terminal
      changed = this.recompute(record, now) || changed
    }
    if (changed) this.publish()
  }

  snapshot(now = Date.now()): DashboardSnapshot {
    const sessions = [...this.records.values()].map(record => toView(record))
    let aggregate: TrafficState = 'idle'
    for (const session of sessions) {
      if (PRIORITY[session.state] > PRIORITY[aggregate]) aggregate = session.state
    }
    return {
      version: 1,
      generatedAt: now,
      aggregate,
      sessions,
    }
  }

  private upsert(registration: SessionRegistration, now: number): MutableSession {
    let record = this.records.get(registration.id)
    if (record === undefined) {
      record = {
        id: registration.id,
        name: sessionName(registration.id, registration.cwd),
        createdAt: registration.createdAt ?? now,
        agentLive: registration.agentLive ?? false,
        sessionLive: registration.sessionLive ?? false,
        driverStatus: registration.driverStatus ?? 'idle',
        activeApprovals: new Set(),
        activeQuestions: new Set(),
        state: 'idle',
        stateSince: now,
        detail: 'No active agent driver',
        lastSeq: -1,
      }
      this.records.set(record.id, record)
    }

    if (registration.cwd !== undefined) {
      record.cwd = registration.cwd
      record.name = sessionName(record.id, registration.cwd)
    }
    if (registration.createdAt !== undefined) record.createdAt = registration.createdAt
    if (registration.parentSession !== undefined) record.parentSession = registration.parentSession
    if (registration.origin !== undefined) record.origin = registration.origin
    if (registration.agentLive !== undefined) record.agentLive = registration.agentLive
    if (registration.sessionLive !== undefined) record.sessionLive = registration.sessionLive
    if (registration.driverStatus !== undefined) record.driverStatus = registration.driverStatus
    return record
  }

  private applyEvent(record: MutableSession, event: SessionEvent): void {
    record.lastSeq = event.seq
    record.lastEvent = event.type

    switch (event.type) {
      case 'turn/start':
        record.driverStatus = 'running'
        record.activeApprovals.clear()
        record.activeQuestions.clear()
        delete record.terminal
        break

      case 'turn/end': {
        record.driverStatus = 'idle'
        record.activeApprovals.clear()
        record.activeQuestions.clear()
        const reason = event.data.reason
        switch (reason.kind) {
          case 'completed':
            record.terminal = {
              state: 'completed',
              since: event.time,
              expiresAt: event.time + this.completedHoldMs,
              detail: 'Turn completed successfully',
            }
            break
          case 'blocked':
            record.terminal = {
              state: 'attention',
              since: event.time,
              detail: 'Turn is blocked and needs attention',
            }
            break
          case 'max-tokens':
            record.terminal = {
              state: 'attention',
              since: event.time,
              detail: 'Turn reached its output-token ceiling',
            }
            break
          case 'error':
            record.terminal = {
              state: 'failed',
              since: event.time,
              detail: describeError(reason.error),
            }
            break
          case 'interrupted':
            record.terminal = {
              state: 'failed',
              since: event.time,
              detail: 'Crash recovery closed an interrupted turn',
            }
            break
          case 'aborted':
            delete record.terminal
            break
          default:
            // TurnEndReasonMap is merge-extensible. Unknown plugin reasons stay
            // neutral instead of being guessed into success or failure.
            delete record.terminal
            break
        }
        break
      }

      case 'approval/asked':
        record.activeApprovals.add(String(event.data.id))
        break

      case 'approval/decided':
        record.activeApprovals.delete(String(event.data.id))
        break

      case 'tool/call':
        if (event.data.name === 'ask_user_question') {
          record.activeQuestions.add(String(event.data.callId))
        }
        break

      case 'tool/result':
        record.activeQuestions.delete(String(event.data.message.source.callId))
        break

      default:
        break
    }
  }

  private recompute(record: MutableSession, now: number): boolean {
    if (record.terminal?.state === 'completed'
      && record.terminal.expiresAt !== undefined
      && record.terminal.expiresAt <= now) {
      delete record.terminal
    }

    let state: TrafficState
    let since: number
    let detail: string

    if (record.terminal !== undefined) {
      state = record.terminal.state
      since = record.terminal.since
      detail = record.terminal.detail
    } else if (record.activeApprovals.size > 0) {
      state = 'attention'
      since = now
      detail = 'Waiting for an approval decision'
    } else if (record.activeQuestions.size > 0) {
      state = 'attention'
      since = now
      detail = 'Waiting for an answer to ask_user_question'
    } else if (record.driverStatus === 'running') {
      state = 'running'
      since = now
      detail = 'Agent driver is active'
    } else {
      state = 'idle'
      since = now
      detail = 'No active agent driver'
    }

    const changed = record.state !== state
    record.detail = detail
    if (changed) {
      record.state = state
      record.stateSince = since
    }
    return changed
  }

  private publish(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function sessionName(id: string, cwd?: string): string {
  if (cwd === undefined) return abbreviate(id, 18)
  const normalized = cwd.replace(/[\\/]+$/, '')
  const name = normalized.split(/[\\/]/).at(-1)
  return name === undefined || name.length === 0 ? abbreviate(id, 18) : name
}

function abbreviate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function toView(record: MutableSession): SessionView {
  const view: SessionView = {
    id: record.id,
    shortId: abbreviate(record.id, 8),
    name: record.name,
    createdAt: record.createdAt,
    agentLive: record.agentLive,
    sessionLive: record.sessionLive,
    driverStatus: record.driverStatus,
    state: record.state,
    stateSince: record.stateSince,
    detail: record.detail,
  }
  if (record.cwd !== undefined) view.cwd = record.cwd
  if (record.parentSession !== undefined) view.parentSession = record.parentSession
  if (record.origin !== undefined) view.origin = record.origin
  if (record.lastEvent !== undefined) view.lastEvent = record.lastEvent
  return view
}
