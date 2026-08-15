import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DashboardSnapshot, SessionView, TrafficState } from '../../src/contracts'
import { demoSnapshot } from './demo'

interface DesktopSnapshotMessage {
  connected: boolean
  snapshot: DashboardSnapshot | null
}

declare global {
  interface Window {
    dshTrafficLight?: {
      onSnapshot: (listener: (message: DesktopSnapshotMessage) => void) => () => void
      quit: () => void
    }
  }
}

const STATE_LABELS: Record<TrafficState, string> = {
  running: 'Running',
  attention: 'Attention',
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
}

const referenceSession: SessionView = {
  ...demoSnapshot.sessions[0]!,
  id: '__reference__',
  shortId: 'codex',
  name: 'Codex',
  state: 'attention',
  detail: 'Waiting for an approval decision',
}

export function DesktopApp() {
  const bridge = window.dshTrafficLight
  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const requestedSession = query.get('session')
  const isReferencePreview = bridge === undefined
  const [message, setMessage] = useState<DesktopSnapshotMessage>(() => (
    isReferencePreview
      ? { connected: true, snapshot: { ...demoSnapshot, sessions: [referenceSession] } }
      : { connected: false, snapshot: null }
  ))

  useEffect(() => bridge?.onSnapshot(setMessage), [bridge])

  const session = requestedSession === '__host__'
    ? undefined
    : message.snapshot?.sessions.find(item => item.id === requestedSession)
      ?? message.snapshot?.sessions[0]
  const tower = session ?? hostSession(message.snapshot)
  const state = message.connected ? tower.state : 'idle'

  return (
    <TrafficTower
      connected={message.connected}
      session={tower}
      state={state}
    />
  )
}

function TrafficTower({
  connected,
  session,
  state,
}: {
  connected: boolean
  session: SessionView
  state: TrafficState
}) {
  const titleRef = useRef<HTMLElement>(null)
  const [titleOverflows, setTitleOverflows] = useState(false)

  useLayoutEffect(() => {
    const title = titleRef.current
    if (title === null) return

    const updateOverflow = () => {
      const context = document.createElement('canvas').getContext('2d')
      if (context === null) {
        setTitleOverflows(title.scrollWidth > title.clientWidth + 1)
        return
      }

      const style = window.getComputedStyle(title)
      context.font = style.font
      const textWidth = context.measureText(title.textContent ?? '').width
      const letterSpacing = Number.parseFloat(style.letterSpacing)
      const spacingWidth = Number.isFinite(letterSpacing)
        ? Math.max(0, (title.textContent?.length ?? 0) - 1) * letterSpacing
        : 0
      setTitleOverflows(textWidth + spacingWidth > title.clientWidth + 1)
    }
    updateOverflow()

    const observer = new ResizeObserver(updateOverflow)
    observer.observe(title)
    return () => { observer.disconnect() }
  }, [session.name])

  return (
    <main
      className={`traffic-tower traffic-tower--${state}${connected ? '' : ' traffic-tower--offline'}`}
      title={`${session.name} · ${connected ? STATE_LABELS[state] : 'Harness offline'} · ${session.detail} · 右键选择关闭悬浮灯`}
    >
      <header className="tower-header">
        <strong
          className={titleOverflows ? 'tower-header__title tower-header__title--overflow' : 'tower-header__title'}
          ref={titleRef}
        >
          {session.name}
        </strong>
      </header>
      <div className="tower-lamps" role="img" aria-label={`${session.name}: ${STATE_LABELS[state]}`}>
        <TowerLamp active={state === 'failed'} color="red" />
        <TowerLamp active={state === 'running' || state === 'attention'} color="yellow" motion={state} />
        <TowerLamp active={state === 'completed'} color="green" />
      </div>
    </main>
  )
}

function TowerLamp({
  active,
  color,
  motion,
}: {
  active: boolean
  color: 'red' | 'yellow' | 'green'
  motion?: TrafficState
}) {
  const motionClass = active && (motion === 'running' || motion === 'attention')
    ? ` tower-lamp--${motion}`
    : ''
  return (
    <span className={`tower-lamp tower-lamp--${color}${active ? ' tower-lamp--active' : ''}${motionClass}`}>
      <span className="tower-lamp-glass" />
    </span>
  )
}

function hostSession(snapshot: DashboardSnapshot | null): SessionView {
  const now = Date.now()
  return {
    id: '__host__',
    shortId: 'dsh',
    name: 'DSH',
    createdAt: now,
    agentLive: false,
    sessionLive: false,
    driverStatus: 'idle',
    state: snapshot?.aggregate ?? 'idle',
    stateSince: now,
    detail: snapshot === null ? 'Waiting for DeepSeek Harness' : 'No Harness sessions',
  }
}
