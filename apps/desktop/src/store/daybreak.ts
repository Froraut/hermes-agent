import { atom } from 'nanostores'

import { $activeGatewayProfile, resolveNewChatOwnerRoute } from '@/store/profile'
import { $connection, $sessions, resolveComposerSessionKey } from '@/store/session'

// Daybreak is a choice for a conversation, not a credential. Explicit choices
// stay in memory; without one a conversation follows the profile default
// (`agent.daybreak`), which the gateway applies to eligible models itself.
function draftKey(): string {
  const owner = resolveNewChatOwnerRoute()
  const profile = owner?.profile ?? $activeGatewayProfile.get()
  const connection = owner?.connectionId ?? $connection.get()?.connectionId ?? 'local'

  return `__new_chat__:${connection}:${profile}`
}

export const $daybreakSelections = atom<Record<string, boolean>>({})

// A choice made on a model row that isn't selected yet, per conversation and
// provider::model. Like a speed preset, it applies when that model is selected.
export const $daybreakModelChoices = atom<Record<string, Record<string, boolean>>>({})

/** These model ids require a Daybreak program even when no switch choice is sent. */
export function daybreakOnlyModel(model: string): boolean {
  const slug = model.trim().toLowerCase()

  return (
    slug.startsWith('gpt-daybreak-blue-') || slug.startsWith('gpt-daybreak-red-') || slug.startsWith('gpt-5.6-cyber')
  )
}

export const daybreakKeyFor = (storedSessionId: null | string, runtimeId?: null | string): string =>
  resolveComposerSessionKey(storedSessionId, $sessions.get()) || storedSessionId || runtimeId || draftKey()

export function daybreakSelectionFor(storedSessionId: null | string, runtimeId?: null | string): boolean | undefined {
  const selections = $daybreakSelections.get()

  return selections[daybreakKeyFor(storedSessionId, runtimeId)] ?? (runtimeId ? selections[runtimeId] : undefined)
}

export function setDaybreakSelection(
  storedSessionId: null | string,
  enabled: boolean,
  runtimeId?: null | string
): void {
  $daybreakSelections.set({ ...$daybreakSelections.get(), [daybreakKeyFor(storedSessionId, runtimeId)]: enabled })
}

/** Drop the conversation's explicit choice so it follows the profile default again. */
export function clearDaybreakSelection(storedSessionId: null | string, runtimeId?: null | string): void {
  const selections = $daybreakSelections.get()
  const key = daybreakKeyFor(storedSessionId, runtimeId)

  if (key in selections || (runtimeId && runtimeId in selections)) {
    const next = { ...selections }
    delete next[key]

    if (runtimeId) {
      delete next[runtimeId]
    }

    $daybreakSelections.set(next)
  }
}

export function daybreakModelChoiceFor(
  storedSessionId: null | string,
  modelKey: string,
  runtimeId?: null | string
): boolean | undefined {
  const choices = $daybreakModelChoices.get()

  return (
    choices[daybreakKeyFor(storedSessionId, runtimeId)]?.[modelKey] ??
    (runtimeId ? choices[runtimeId]?.[modelKey] : undefined)
  )
}

export function setDaybreakModelChoice(
  storedSessionId: null | string,
  modelKey: string,
  enabled: boolean,
  runtimeId?: null | string
): void {
  const choices = $daybreakModelChoices.get()
  const key = daybreakKeyFor(storedSessionId, runtimeId)
  $daybreakModelChoices.set({ ...choices, [key]: { ...choices[key], [modelKey]: enabled } })
}

export function adoptDraftDaybreakSelection(storedSessionId: string, sourceDraftKey: string): void {
  const choices = $daybreakModelChoices.get()

  if (sourceDraftKey in choices) {
    const { [sourceDraftKey]: draftChoices, ...restChoices } = choices
    $daybreakModelChoices.set({ ...restChoices, [storedSessionId]: { ...choices[storedSessionId], ...draftChoices } })
  }

  const selections = $daybreakSelections.get()

  if (!(sourceDraftKey in selections)) {
    return
  }

  const { [sourceDraftKey]: enabled, ...rest } = selections
  $daybreakSelections.set({ ...rest, [storedSessionId]: enabled })
}
