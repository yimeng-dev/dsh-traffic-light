import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { TrafficLightStore } from './store.js'

function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq: number,
  time = 1_000 + seq,
): Extract<SessionEvent, { type: T }> {
  return { type, data, seq, time } as Extract<SessionEvent, { type: T }>
}

function state(store: TrafficLightStore): string {
  return store.snapshot(2_000).sessions[0]?.state ?? 'missing'
}

describe('TrafficLightStore', () => {
  it('maps running, completed and completed expiry without letting idle erase green immediately', () => {
    const store = new TrafficLightStore(90_000)
    store.registerSession({ id: 's1', agentLive: true, sessionLive: true })
    store.setAgentStatus('s1', 'running', 1_000)
    expect(state(store)).toBe('running')

    store.recordSessionEvent('s1', event('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    }, 0, 1_500), 1_500)
    store.setAgentStatus('s1', 'idle', 1_501)
    expect(state(store)).toBe('completed')

    store.sweep(91_501)
    expect(store.snapshot(91_501).sessions[0]?.state).toBe('idle')
  })

  it('maps approvals and ask_user_question pairs to attention', () => {
    const store = new TrafficLightStore(90_000)
    store.registerSession({ id: 's1', agentLive: true, driverStatus: 'running' })

    store.recordSessionEvent('s1', event('approval/asked', {
      id: 'approval-1' as never,
      toolName: 'bash',
    }, 0), 1_000)
    expect(state(store)).toBe('attention')

    store.recordSessionEvent('s1', event('approval/decided', {
      id: 'approval-1' as never,
      outcome: 'allowed-once',
    }, 1), 1_001)
    expect(state(store)).toBe('running')

    store.recordSessionEvent('s1', event('tool/call', {
      turn: 1,
      step: 1,
      callId: 'question-1' as never,
      name: 'ask_user_question',
      arguments: '{}',
    }, 2), 1_002)
    expect(state(store)).toBe('attention')

    store.recordSessionEvent('s1', event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-1',
        role: 'user',
        source: { kind: 'tool', callId: 'question-1' },
        content: [{ type: 'tool-result', callId: 'question-1', content: [] }],
      } as never,
    }, 3), 1_003)
    expect(state(store)).toBe('running')
  })

  it.each([
    ['blocked', 'attention'],
    ['max-tokens', 'attention'],
    ['error', 'failed'],
    ['interrupted', 'failed'],
    ['aborted', 'idle'],
  ] as const)('maps turn end reason %s to %s', (kind, expected) => {
    const store = new TrafficLightStore(90_000)
    store.registerSession({ id: 's1', agentLive: true, driverStatus: 'running' })
    const reason = kind === 'error'
      ? { kind, error: { message: 'boom', code: 'UNKNOWN' } }
      : kind === 'aborted'
        ? { kind, reason: { kind: 'user' } }
        : { kind }
    store.recordSessionEvent('s1', event('turn/end', { turn: 1, reason } as never, 0), 1_000)
    expect(state(store)).toBe(expected)
  })

  it('does not classify an isolated tool result error as a failed session', () => {
    const store = new TrafficLightStore(90_000)
    store.registerSession({ id: 's1', agentLive: true, driverStatus: 'running' })
    store.recordSessionEvent('s1', event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', callId: 'call-1', content: [] }],
      } as never,
      error: { name: 'ToolError', code: 'FAILED' },
    }, 0), 1_000)
    expect(state(store)).toBe('running')
  })

  it('uses failed > attention > running > completed > idle aggregate priority', () => {
    const store = new TrafficLightStore(90_000)
    store.registerSession({ id: 'running', agentLive: true, driverStatus: 'running' })
    store.recordConfigStartFailure('failed', new Error('cannot start'), 1_100)
    expect(store.snapshot(1_200).aggregate).toBe('failed')
  })
})
