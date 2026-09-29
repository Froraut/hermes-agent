import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $activeSessionId } from '@/store/session'
import {
  $sessionStates,
  $workingSessionIds,
  clearAllSessionStates,
  LIVE_TURN_EVENT_SILENCE_MS,
  noteSessionEvent,
  publishSessionState,
  setLiveTurnBackend
} from '@/store/session-states'

import { renderMessageStream } from './test-harness'

const SID = 'turn-alive'
// tui_gateway/turn_alive.py TURN_ALIVE_INTERVAL_S
const TURN_ALIVE_S = 15

let releaseBackend: () => void = () => undefined

beforeEach(() => {
  vi.useFakeTimers()
  clearAllSessionStates()
  $activeSessionId.set(SID)
})

afterEach(() => {
  cleanup()
  releaseBackend()
  releaseBackend = () => undefined
  vi.useRealTimers()
  clearAllSessionStates()
  $activeSessionId.set(null)
})

function quietTurn(): ClientSessionState {
  return {
    ...createClientSessionState('s-turn-alive'),
    awaitingResponse: true,
    busy: true,
    messages: [
      { id: 'a1', parts: [{ text: 'Running the test suite', type: 'text' }], pending: true, role: 'assistant' }
    ],
    sawAssistantPayload: true,
    streamId: 'a1',
    turnLive: true,
    turnStartedAt: Date.now()
  }
}

it('turn.alive keeps a quiet turn live without ever asking session.active_list', async () => {
  const live = quietTurn()
  publishSessionState(SID, live)
  const stream = renderMessageStream(SID, { states: new Map([[SID, live]]) })
  const request = vi.fn(async () => ({ sessions: [] }))
  releaseBackend = setLiveTurnBackend({ request: request as never })
  noteSessionEvent(SID)

  // A ten-minute tool call: nothing but the gateway's liveness frames.
  for (let tick = 0; tick < 40; tick += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TURN_ALIVE_S * 1000)
      stream.handleEvent({
        payload: { activity: 'executing tool: terminal', quiet_s: TURN_ALIVE_S, status: 'working' },
        session_id: SID,
        type: 'turn.alive'
      })
    })
  }

  expect(request).not.toHaveBeenCalled()
  expect($workingSessionIds.get()).toContain('s-turn-alive')
  // Liveness changes no state.
  expect($sessionStates.get()[SID]).toBe(live)
  expect(stream.state(SID)).toBe(live)

  // The frames stop (a backend without turn.alive, or one whose turn died):
  // the silence window falls back to asking.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_TURN_EVENT_SILENCE_MS)
  })

  expect(request).toHaveBeenCalledTimes(1)
})
