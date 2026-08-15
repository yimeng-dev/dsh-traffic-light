import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'

/** Minimal official persistence face used by the telemetry adapter. */
export interface SessionPersistenceSnapshot {
  readonly header: SessionHeader
  readonly revision: unknown
}

export interface SessionInspection {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

export interface SessionPersistencePort {
  listSnapshots(signal?: AbortSignal): Promise<readonly SessionPersistenceSnapshot[]>
  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistencePort
  }
}
