import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-approval'
import Schema from '@deepseek-ai/schemastery'
import { DesktopProcessController } from './desktop-process.js'
import { registerRoutes, SseHub } from './http.js'
import type { SessionView } from './contracts.js'
import { readDshLocalePreference, type DshLocale } from './locale.js'
import type { SessionSwitchGroup } from './session-settings.js'
import { resolveSessionSettingsFilePath, SessionSettingsStore } from './session-settings.js'
import { resolveStateFilePath, StateFilePublisher } from './state-file.js'
import { TrafficLightStore } from './store.js'
import type {} from './session-persistence.js'
import type { WorkspaceRecord } from './workspace-settings.js'

export const name = 'dsh-traffic-light'
const dshLocaleSettingsNamespace = 'locale' as SettingsNamespace
export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'webServer',
  'workspaceRegistry',
]

export interface Config {
  basePath: string
  completedHoldMs: number
  stateFile: string
  settingsFile: string
  desktopExecutable: string
}

export const Config: Schema<Config> = Schema.object({
  basePath: Schema.string().default('/dsh-traffic-light'),
  completedHoldMs: Schema.number().min(0).max(86_400_000).default(90_000),
  stateFile: Schema.string().default(''),
  settingsFile: Schema.string().default(''),
  desktopExecutable: Schema.string().default(''),
})

export function apply(ctx: Context, config: Config): void {
  assertBasePath(config.basePath)

  let localePreference: DshLocale | undefined
  ctx.inject(['settings'], settingsCtx => {
    const refreshLocalePreference = () => {
      localePreference = readDshLocalePreference(
        settingsCtx.settings.get(dshLocaleSettingsNamespace),
      )
    }
    refreshLocalePreference()
    return settingsCtx.on('settings/updated', namespace => {
      if (namespace === dshLocaleSettingsNamespace) refreshLocalePreference()
    })
  })

  const store = new TrafficLightStore(config.completedHoldMs)
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url))
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
  const sse = new SseHub(() => store.snapshot())
  const logger = ctx.logger(name)
  const stateFile = new StateFilePublisher(
    resolveStateFilePath(config.stateFile),
    error => { logger.warn('Failed to publish desktop state file', error) },
  )
  const sessionSettings = new SessionSettingsStore(
    resolveSessionSettingsFilePath(config.settingsFile),
    error => { logger.warn('Failed to load or save Session settings', error) },
  )
  const desktop = new DesktopProcessController(
    projectRoot,
    stateFile.path,
    sessionSettings.path,
    config.desktopExecutable,
    { warn: (message, error) => { logger.warn(message, error) } },
  )

  // Prepare Electron after the Host gets a chance to finish its own startup.
  // This does not open a desktop window.  It only restores the normal Electron
  // install step that DSH's guarded pnpm installation may have skipped.
  ctx.effect(() => {
    const timer = setTimeout(() => { void desktop.prewarmRuntime() }, 0)
    return () => { clearTimeout(timer) }
  }, 'dsh-traffic-light.desktop-runtime-prewarm')

  const officialWorkspaces = (): WorkspaceRecord[] => ctx.workspaceRegistry.list().map(workspace => ({
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    sessionIds: (workspace.sessionIds ?? []).map(String),
  }))

  const desktopSnapshot = (snapshot = store.snapshot()) => {
    return {
      ...snapshot,
      enabledSessionIds: sessionSettings.enabledIds(),
    }
  }

  const publishDesktop = async (snapshot = store.snapshot(), online = true): Promise<void> => {
    await sessionSettings.ready
    await stateFile.publish(desktopSnapshot(snapshot), online)
  }

  const syncDesktopProcess = async (): Promise<void> => {
    await desktop.setDesiredRunning(sessionSettings.enabledIds().length > 0)
  }

  ctx.effect(() => {
    let active = true
    let watcher: FSWatcher | undefined
    let refreshTimer: NodeJS.Timeout | undefined

    const refreshFromDisk = () => {
      if (!active || refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        void (async () => {
          try {
            await sessionSettings.reload()
            if (!active) return
            await publishDesktop()
            await syncDesktopProcess()
          } catch (error) {
            logger.warn('Failed to refresh Session settings changed by desktop', error)
          }
        })()
      }, 50)
    }

    void (async () => {
      await sessionSettings.ready
      if (!active) return
      const directory = dirname(sessionSettings.path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (!active) return
      try {
        watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename === null || filename.toString() === basename(sessionSettings.path)) {
            refreshFromDisk()
          }
        })
      } catch (error) {
        logger.warn('Failed to watch Session settings for desktop changes', error)
      }
    })()

    return () => {
      active = false
      watcher?.close()
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    }
  }, 'dsh-traffic-light.session-settings-relay')

  const migrateSessionSettings = async (): Promise<void> => {
    await sessionSettings.ready
    await sessionSettings.migrateLegacyWorkspaceIds(officialWorkspaces())
  }

  // A Session can remain visible in the official Workspace browser after its
  // live Agent/Session object has been disposed. The live store alone therefore
  // misses exactly the historical Session that a second workspace switch needs.
  // Re-adopt those official persisted logs by revision, while live sessions keep
  // their event-stream fast path.
  const persistedRevisions = new Map<string, string>()
  ctx.effect(() => {
    let active = true

    const adoptPersistedSessions = async (): Promise<void> => {
      let snapshots
      try {
        snapshots = await ctx.sessionPersistence.listSnapshots()
      } catch (error) {
        logger.warn('Failed to list persisted sessions for traffic-light adoption', error)
        return
      }

      const liveIds = new Set(ctx.sessions.list().map(session => String(session.id)))
      for (const snapshot of snapshots) {
        if (!active) return
        const id = String(snapshot.header.id)
        if (liveIds.has(id)) {
          persistedRevisions.delete(id)
          continue
        }

        const revision = JSON.stringify(snapshot.revision)
        if (persistedRevisions.get(id) === revision) continue
        try {
          const inspection = await ctx.sessionPersistence.inspect(snapshot.header.id)
          store.ingestSession(registrationForHeader(inspection.meta), inspection.events)
          persistedRevisions.set(id, revision)
        } catch (error) {
          logger.warn(`Failed to inspect persisted Session ${id}`, error)
        }
      }
    }

    void adoptPersistedSessions()
    const timer = setInterval(() => { void adoptPersistedSessions() }, 3_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, 'dsh-traffic-light.persisted-session-adoption')

  ctx.effect(() => registerRoutes({
    basePath: config.basePath,
    webRoot,
    webServer: ctx.webServer,
    snapshot: () => store.snapshot(),
    reset: () => {
      store.resetTerminalStates()
      return store.snapshot()
    },
    sessions: async () => {
      await migrateSessionSettings()
      return sessionSettings.snapshot(buildSessionSwitchGroups(
        officialWorkspaces(),
        store.snapshot().sessions,
        sessionSettings,
      ))
    },
    localePreference: () => localePreference,
    toggleSession: async (sessionId, enabled) => {
      await migrateSessionSettings()
      const sessions = store.snapshot().sessions
      if (!sessions.some(session => session.id === sessionId)) {
        throw new Error(`Unknown Session: ${sessionId}`)
      }
      await sessionSettings.setEnabled(sessionId, enabled)
      await publishDesktop()
      await syncDesktopProcess()
      return sessionSettings.snapshot(buildSessionSwitchGroups(
        officialWorkspaces(),
        store.snapshot().sessions,
        sessionSettings,
      ))
    },
    sse,
  }), 'dsh-traffic-light.routes')

  ctx.effect(() => {
    const unsubscribe = store.subscribe(snapshot => {
      sse.broadcast(snapshot)
      void publishDesktop(snapshot)
    })
    let active = true
    void (async () => {
      await migrateSessionSettings()
      if (!active) return
      await publishDesktop()
      if (active) await syncDesktopProcess()
    })()
    return async () => {
      active = false
      unsubscribe()
      await publishDesktop(store.snapshot(), false)
      desktop.dispose()
    }
  }, 'dsh-traffic-light.snapshot-relay')

  ctx.effect(() => {
    const sweepTimer = setInterval(() => { store.sweep() }, 1_000)
    const stateHeartbeat = setInterval(() => { void publishDesktop() }, 5_000)
    const pingTimer = setInterval(() => { sse.ping() }, 15_000)
    return () => {
      clearInterval(sweepTimer)
      clearInterval(stateHeartbeat)
      clearInterval(pingTimer)
      sse.close()
    }
  }, 'dsh-traffic-light.timers')

  // Register listeners before the adoption sweep. If an event lands during the
  // sweep, the Session log already contains it and the store's seq guard keeps
  // the replay plus live callback idempotent.
  ctx.on('session/created', (session) => {
    persistedRevisions.delete(String(session.id))
    store.ingestSession(registrationForSession(session), session.events)
  })
  ctx.on('session/event', (session, event) => {
    store.recordSessionEvent(String(session.id), event)
  })
  ctx.on('session/disposed', (session) => {
    persistedRevisions.delete(String(session.id))
    store.removeSession(String(session.id))
  })

  ctx.on('agent/created', ({ agent }) => {
    store.markAgentCreated(registrationForAgent(agent))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    store.markAgentDisposed(String(agent.id))
  })
  ctx.on('agent/status', ({ agent, status }) => {
    store.setAgentStatus(String(agent.id), status)
  })
  ctx.on('agent/error', ({ agent, error }) => {
    store.recordAgentError(String(agent.id), error)
  })
  ctx.on('agent-loop/config-start-failed', ({ sessionId, error }) => {
    store.recordConfigStartFailure(String(sessionId), error)
  })

  const agents = new Map(ctx.agents.list().map(agent => [String(agent.id), agent]))
  for (const session of ctx.sessions.list()) {
    const agent = agents.get(String(session.id))
    store.ingestSession({
      ...registrationForSession(session),
      agentLive: agent !== undefined,
      driverStatus: agent?.status ?? 'idle',
    }, session.events)
  }
}

function buildSessionSwitchGroups(
  workspaces: readonly WorkspaceRecord[],
  sessions: readonly SessionView[],
  settings: SessionSettingsStore,
): SessionSwitchGroup[] {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const claimed = new Set<string>()
  const enabledIds = new Set(settings.enabledIds())
  const groups: SessionSwitchGroup[] = []

  for (const workspace of workspaces) {
    const groupSessions = (workspace.sessionIds ?? [])
      .map(String)
      .map(id => {
        claimed.add(id)
        return byId.get(id)
      })
      .filter((session): session is SessionView => session !== undefined)
      .map(session => sessionSwitchView(session, enabledIds))
    groups.push({ id: workspace.id, title: workspace.title, sessions: groupSessions })
  }

  const ungrouped = sessions
    .filter(session => !claimed.has(session.id))
    .map(session => sessionSwitchView(session, enabledIds))
  if (ungrouped.length > 0) {
    groups.push({ id: '__ungrouped__', title: '未分组', sessions: ungrouped })
  }
  return groups
}

function sessionSwitchView(session: SessionView, enabledIds: ReadonlySet<string>) {
  return {
    id: session.id,
    label: session.name,
    shortId: session.shortId,
    enabled: enabledIds.has(session.id),
    visible: session.lastEvent !== undefined || session.agentLive || session.state !== 'idle',
  }
}

function registrationForSession(session: Session) {
  const registration: {
    id: string
    cwd?: string
    createdAt: number
    parentSession?: string
    origin?: 'subagent'
    sessionLive: boolean
  } = {
    id: String(session.id),
    createdAt: session.header.createdAt,
    sessionLive: true,
  }
  if (session.header.cwd !== undefined) registration.cwd = session.header.cwd
  if (session.header.parentSession !== undefined) registration.parentSession = String(session.header.parentSession)
  if (session.header.origin !== undefined) registration.origin = session.header.origin
  return registration
}

function registrationForHeader(header: SessionHeader) {
  const registration: {
    id: string
    cwd?: string
    createdAt: number
    parentSession?: string
    origin?: 'subagent'
    agentLive: boolean
    sessionLive: boolean
    driverStatus: 'idle'
  } = {
    id: String(header.id),
    createdAt: header.createdAt,
    agentLive: false,
    sessionLive: false,
    driverStatus: 'idle',
  }
  if (header.cwd !== undefined) registration.cwd = header.cwd
  if (header.parentSession !== undefined) registration.parentSession = String(header.parentSession)
  if (header.origin !== undefined) registration.origin = header.origin
  return registration
}

function registrationForAgent(agent: Agent) {
  return {
    ...registrationForSession(agent.session),
    agentLive: true,
    driverStatus: agent.status,
  }
}

function assertBasePath(basePath: string): void {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(basePath)
    || basePath.endsWith('/')
    || basePath.includes('//')) {
    throw new Error('dsh-traffic-light basePath must be an absolute URL path without a trailing slash')
  }
}

export { TrafficLightStore } from './store.js'
export type { DashboardSnapshot, SessionView, TrafficState } from './contracts.js'
