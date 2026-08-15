import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DashboardSnapshot, SessionView, TrafficState } from '../../src/contracts'
import { demoSnapshot } from './demo'

const API_BASE = new URL('./api/', window.location.href)
const STATE_LABELS: Record<TrafficState, string> = {
  running: 'Running',
  attention: 'Attention',
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
}

type ConnectionState = 'connecting' | 'live' | 'offline' | 'demo'

function useDashboard() {
  const isDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).get('live') !== '1'
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(isDemo ? demoSnapshot : emptySnapshot())
  const [connection, setConnection] = useState<ConnectionState>(isDemo ? 'demo' : 'connecting')
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    if (isDemo) return

    let eventSource: EventSource | undefined
    let cancelled = false

    async function connect() {
      try {
        const response = await fetch(new URL('state', API_BASE), { cache: 'no-store' })
        if (!response.ok) throw new Error(`state request failed: ${response.status}`)
        const next = await response.json() as DashboardSnapshot
        if (cancelled) return
        setSnapshot(next)
        eventSource = new EventSource(new URL('events', API_BASE))
        eventSource.addEventListener('snapshot', (message) => {
          setSnapshot(JSON.parse((message as MessageEvent<string>).data) as DashboardSnapshot)
          setConnection('live')
        })
        eventSource.onopen = () => { setConnection('live') }
        eventSource.onerror = () => { setConnection('offline') }
      } catch {
        if (!cancelled) setConnection('offline')
      }
    }

    void connect()
    return () => {
      cancelled = true
      eventSource?.close()
    }
  }, [isDemo])

  const reset = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    try {
      if (isDemo) {
        setSnapshot({
          ...demoSnapshot,
          generatedAt: Date.now(),
          aggregate: 'attention',
          sessions: demoSnapshot.sessions.map(session => (
            session.state === 'failed' || session.state === 'completed'
              ? { ...session, state: 'idle', detail: 'No active agent driver', stateSince: Date.now() }
              : session
          )),
        })
      } else {
        const response = await fetch(new URL('reset', API_BASE), { method: 'POST' })
        if (!response.ok) throw new Error(`reset request failed: ${response.status}`)
        setSnapshot(await response.json() as DashboardSnapshot)
      }
    } finally {
      window.setTimeout(() => { setResetting(false) }, 350)
    }
  }, [isDemo, resetting])

  return { connection, isDemo, reset, resetting, snapshot }
}

export function App() {
  const { connection, isDemo, reset, resetting, snapshot } = useDashboard()
  const [now, setNow] = useState(Date.now())
  const [selected, setSelected] = useState<string | null>(snapshot.sessions[0]?.id ?? null)

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (selected === null && snapshot.sessions[0] !== undefined) setSelected(snapshot.sessions[0].id)
  }, [selected, snapshot.sessions])

  return (
    <div className="app-shell">
      <TopBar connection={connection} isDemo={isDemo} onReset={() => { void reset() }} resetting={resetting} />
      <main>
        <section className="overview" aria-labelledby="dashboard-title">
          <div>
            <h1 id="dashboard-title">Harness sessions</h1>
            <p>Live state across one DeepSeek Harness host</p>
          </div>
          <div className="host-status">
            <span>Host status</span>
            <TrafficLight compact={false} state={snapshot.aggregate} label={`Host status: ${STATE_LABELS[snapshot.aggregate]}`} />
          </div>
        </section>

        <SessionTable
          now={now}
          onSelect={setSelected}
          selected={selected}
          sessions={snapshot.sessions}
        />

        <Legend />
      </main>
    </div>
  )
}

function TopBar({
  connection,
  isDemo,
  onReset,
  resetting,
}: {
  connection: ConnectionState
  isDemo: boolean
  onReset: () => void
  resetting: boolean
}) {
  const statusText = isDemo ? 'Demo' : connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'
  return (
    <header className="topbar">
      <div className="brand">
        <span className="prompt-mark" aria-hidden="true">›_</span>
        <strong>dsh-traffic-light</strong>
        <span className={`connection connection--${connection}`}>
          <span className="connection-dot" aria-hidden="true" />
          {statusText}
        </span>
      </div>
      <button className="reset-button" type="button" onClick={onReset} disabled={resetting}>
        <ResetIcon />
        <span>{resetting ? 'Resetting' : 'Reset'}</span>
      </button>
    </header>
  )
}

function SessionTable({
  now,
  onSelect,
  selected,
  sessions,
}: {
  now: number
  onSelect: (id: string) => void
  selected: string | null
  sessions: SessionView[]
}) {
  if (sessions.length === 0) {
    return (
      <section className="empty-state">
        <TrafficLight compact={false} state="idle" label="No active sessions" />
        <h2>No Harness sessions</h2>
        <p>The dashboard will update when DSH creates a session.</p>
      </section>
    )
  }

  return (
    <section className="session-table" aria-label="Harness session status">
      <div className="table-head" aria-hidden="true">
        <span>Session</span>
        <span>Session ID</span>
        <span>CWD / Path</span>
        <span>Time in state</span>
        <span>State</span>
        <span>Traffic light</span>
      </div>
      <div className="table-body">
        {sessions.map(session => (
          <button
            className={`session-row${selected === session.id ? ' session-row--selected' : ''}`}
            key={session.id}
            onClick={() => { onSelect(session.id) }}
            type="button"
            aria-pressed={selected === session.id}
            title={session.detail}
          >
            <strong className="session-name">{session.name}</strong>
            <code className="session-id">{session.shortId}</code>
            <code className="session-path">{session.cwd ?? '—'}</code>
            <time className="session-time" dateTime={new Date(session.stateSince).toISOString()}>
              {formatDuration(Math.max(0, now - session.stateSince))}
            </time>
            <span className={`state-label state-label--${session.state}`}>{STATE_LABELS[session.state]}</span>
            <TrafficLight state={session.state} label={`${session.name}: ${STATE_LABELS[session.state]}`} />
          </button>
        ))}
      </div>
    </section>
  )
}

function TrafficLight({
  compact = false,
  label,
  state,
}: {
  compact?: boolean
  label: string
  state: TrafficState
}) {
  const active = useMemo(() => ({
    red: state === 'failed',
    yellow: state === 'running' || state === 'attention',
    green: state === 'completed',
  }), [state])
  return (
    <span className={`traffic-light${compact ? ' traffic-light--compact' : ''}`} role="img" aria-label={label}>
      <span className={`lamp lamp--red${active.red ? ' lamp--on' : ''}`} />
      <span className={`lamp lamp--yellow${active.yellow ? ` lamp--on lamp--${state}` : ''}`} />
      <span className={`lamp lamp--green${active.green ? ' lamp--on' : ''}`} />
    </span>
  )
}

function Legend() {
  const items: Array<{ state: TrafficState; description: string }> = [
    { state: 'running', description: 'slow pulse' },
    { state: 'attention', description: 'fast blink' },
    { state: 'completed', description: 'green' },
    { state: 'failed', description: 'red' },
    { state: 'idle', description: 'off' },
  ]
  return (
    <aside className="legend" aria-label="Traffic light legend">
      {items.map(item => (
        <div className="legend-item" key={item.state}>
          <TrafficLight compact state={item.state} label={STATE_LABELS[item.state]} />
          <span><strong className={`state-label--${item.state}`}>{STATE_LABELS[item.state]}</strong> · {item.description}</span>
        </div>
      ))}
    </aside>
  )
}

function ResetIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
    </svg>
  )
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':')
}

function emptySnapshot(): DashboardSnapshot {
  return { version: 1, generatedAt: Date.now(), aggregate: 'idle', sessions: [] }
}
