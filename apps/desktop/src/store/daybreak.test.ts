import { afterEach, expect, it } from 'vitest'

import {
  $daybreakModelChoices,
  $daybreakSelections,
  adoptDraftDaybreakSelection,
  daybreakKeyFor,
  daybreakModelChoiceFor,
  daybreakSelectionFor,
  setDaybreakModelChoice,
  setDaybreakSelection
} from './daybreak'
import { $activeGatewayProfile, $newChatProfile, $newChatRoute } from './profile'
import { $connection } from './session'

afterEach(() => {
  $daybreakSelections.set({})
  $daybreakModelChoices.set({})
  $newChatProfile.set(null)
  $newChatRoute.set(null)
  $activeGatewayProfile.set('default')
  $connection.set(null)
})

it('does not carry an unsent Daybreak draft into another profile', () => {
  $newChatProfile.set(null)
  $newChatRoute.set(null)
  $connection.set(null)
  $activeGatewayProfile.set('security')
  setDaybreakSelection(null, true)

  $activeGatewayProfile.set('general')
  expect(daybreakSelectionFor(null)).toBeUndefined()

  $activeGatewayProfile.set('security')
  expect(daybreakSelectionFor(null)).toBe(true)
})

it('keeps an unselected model row choice in its conversation until the draft is sent', () => {
  const draftKey = daybreakKeyFor(null)
  setDaybreakModelChoice(null, 'openai-codex::gpt-6-luna', true)

  expect(daybreakSelectionFor(null)).toBeUndefined()
  expect(daybreakModelChoiceFor('other-session', 'openai-codex::gpt-6-luna')).toBeUndefined()

  adoptDraftDaybreakSelection('stored-1', draftKey)
  expect(daybreakModelChoiceFor(null, 'openai-codex::gpt-6-luna')).toBeUndefined()
  expect(daybreakModelChoiceFor('stored-1', 'openai-codex::gpt-6-luna')).toBe(true)
})
