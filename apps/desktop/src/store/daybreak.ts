import { atom } from 'nanostores'

import { $activeGatewayProfile, resolveNewChatOwnerRoute } from '@/store/profile'
import { $connection, $sessions, resolveComposerSessionKey } from '@/store/session'

// Daybreak is a choice for a conversation, not a credential or a global model
// setting. Keep it in memory so another profile or app launch starts off.
function draftKey(): string {
  const owner = resolveNewChatOwnerRoute()
  const profile = owner?.profile ?? $activeGatewayProfile.get()
  const connection = owner?.connectionId ?? $connection.get()?.connectionId ?? 'local'

  return `__new_chat__:${connection}:${profile}`
}

export const $daybreakSelections = atom<Record<string, boolean>>({})

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

export function adoptDraftDaybreakSelection(storedSessionId: string, sourceDraftKey: string): void {
  const selections = $daybreakSelections.get()

  if (!(sourceDraftKey in selections)) {
    return
  }

  const { [sourceDraftKey]: enabled, ...rest } = selections
  $daybreakSelections.set({ ...rest, [storedSessionId]: enabled })
}
