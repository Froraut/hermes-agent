import { atom } from 'nanostores'

// Daybreak is a choice for a conversation, not a credential or a global model
// setting. Keep it in memory so another profile or app launch starts off.
const DRAFT = '__new_chat__'
export const $daybreakSelections = atom<Record<string, boolean>>({})

export const daybreakKeyFor = (storedSessionId: null | string, runtimeId?: null | string): string =>
  storedSessionId || runtimeId || DRAFT

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

export function adoptDraftDaybreakSelection(storedSessionId: string): void {
  const selections = $daybreakSelections.get()

  if (!(DRAFT in selections)) {
    return
  }

  const { [DRAFT]: enabled, ...rest } = selections
  $daybreakSelections.set({ ...rest, [storedSessionId]: enabled })
}
