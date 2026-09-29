import { afterEach, expect, it } from 'vitest'

import { $daybreakSelections, daybreakSelectionFor, setDaybreakSelection } from './daybreak'
import { $activeGatewayProfile, $newChatProfile, $newChatRoute } from './profile'
import { $connection } from './session'

afterEach(() => {
  $daybreakSelections.set({})
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
