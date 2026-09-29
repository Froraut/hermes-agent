import { atom, onMount, type ReadableAtom, type WritableAtom } from 'nanostores'

// Inline diffs are a renderer convenience, not transcript authority. Keep enough
// recent edits for a long visible transcript while putting a hard ceiling on
// retained text (16 KiB average at both limits) and derived-store bookkeeping.
export const MAX_RETAINED_TOOL_DIFF_ENTRIES = 256
export const MAX_RETAINED_TOOL_DIFF_BYTES = 4 * 1024 * 1024
export const MAX_RETAINED_TOOL_DIFF_ATOMS = MAX_RETAINED_TOOL_DIFF_ENTRIES

interface RetainedToolDiff {
  bytes: number
  diff: string
  sessionId?: string
}

interface CachedToolDiffAtom {
  atom: WritableAtom<string>
  discarded?: boolean
  sessionId?: string
}

// Map insertion order is the LRU order: oldest first. Reads and writes promote
// an entry by deleting and re-inserting it, which makes eviction deterministic.
const retainedDiffs = new Map<string, RetainedToolDiff>()
const inlineDiffCache = new Map<string, CachedToolDiffAtom>()
// Mounted rows are live UI ownership, not retention. They move back into the
// bounded cache on unmount only while their diff is still retained.
const mountedDiffAtoms = new Map<string, CachedToolDiffAtom>()
const $emptyToolDiff = atom('')
const textEncoder = new TextEncoder()
let retainedBytes = 0

function promote<T>(entries: Map<string, T>, key: string, value: T): void {
  entries.delete(key)
  entries.set(key, value)
}

function forgetRetainedDiff(toolCallId: string): void {
  const retained = retainedDiffs.get(toolCallId)

  if (!retained) {
    return
  }

  retainedBytes -= retained.bytes
  retainedDiffs.delete(toolCallId)
}

function evictOldestDiff(): void {
  const toolCallId = retainedDiffs.keys().next().value as string | undefined

  if (toolCallId === undefined) {
    return
  }

  forgetRetainedDiff(toolCallId)
  // A mounted row owns its atom reference and keeps painting the completed
  // diff. Dropping only our cache reference releases unmounted rows without
  // broadcasting an empty value to the current transcript.
  inlineDiffCache.delete(toolCallId)
}

function enforceDiffBudgets(): void {
  while (
    retainedDiffs.size > MAX_RETAINED_TOOL_DIFF_ENTRIES ||
    retainedBytes > MAX_RETAINED_TOOL_DIFF_BYTES
  ) {
    evictOldestDiff()
  }
}

function enforceAtomBudget(): void {
  while (inlineDiffCache.size > MAX_RETAINED_TOOL_DIFF_ATOMS) {
    const toolCallId = inlineDiffCache.keys().next().value as string | undefined

    if (toolCallId === undefined) {
      return
    }

    inlineDiffCache.delete(toolCallId)
  }
}

function trackMountedAtom(toolCallId: string, entry: CachedToolDiffAtom): void {
  onMount(entry.atom, () => {
    if (entry.discarded) {
      return
    }

    if (inlineDiffCache.get(toolCallId) === entry) {
      inlineDiffCache.delete(toolCallId)
    }

    mountedDiffAtoms.set(toolCallId, entry)

    return () => {
      if (mountedDiffAtoms.get(toolCallId) !== entry) {
        return
      }

      mountedDiffAtoms.delete(toolCallId)

      if (retainedDiffs.has(toolCallId)) {
        inlineDiffCache.set(toolCallId, entry)
        enforceAtomBudget()
      }
    }
  })
}

export function recordToolDiff(toolCallId: string, diff: string, sessionId?: string): void {
  if (!toolCallId || !diff) {
    return
  }

  const mounted = mountedDiffAtoms.get(toolCallId)
  const cached = mounted ?? inlineDiffCache.get(toolCallId)

  if (cached) {
    cached.sessionId = sessionId || cached.sessionId
    cached.atom.set(diff)

    if (!mounted) {
      promote(inlineDiffCache, toolCallId, cached)
    }
  }

  const current = retainedDiffs.get(toolCallId)

  if (current?.diff === diff) {
    current.sessionId = sessionId || current.sessionId
    promote(retainedDiffs, toolCallId, current)
    enforceAtomBudget()

    return
  }

  forgetRetainedDiff(toolCallId)

  const bytes = textEncoder.encode(diff).byteLength

  if (bytes > MAX_RETAINED_TOOL_DIFF_BYTES) {
    // A row that was already mounted received the value above and keeps its
    // own atom reference. The retention layer must not own an oversized value.
    inlineDiffCache.delete(toolCallId)

    return
  }

  retainedDiffs.set(toolCallId, { bytes, diff, ...(sessionId ? { sessionId } : {}) })
  retainedBytes += bytes
  enforceDiffBudgets()
  enforceAtomBudget()
}

export function getToolDiff(toolCallId: string): string {
  if (!toolCallId) {
    return ''
  }

  const retained = retainedDiffs.get(toolCallId)

  if (!retained) {
    return ''
  }

  promote(retainedDiffs, toolCallId, retained)

  return retained.diff
}

export function $toolInlineDiff(toolCallId: string): ReadableAtom<string> {
  if (!toolCallId) {
    return $emptyToolDiff
  }

  const mounted = mountedDiffAtoms.get(toolCallId)

  if (mounted) {
    const retained = retainedDiffs.get(toolCallId)

    if (retained) {
      promote(retainedDiffs, toolCallId, retained)
    }

    return mounted.atom
  }

  const cached = inlineDiffCache.get(toolCallId)

  if (cached) {
    const retained = retainedDiffs.get(toolCallId)

    if (retained) {
      promote(retainedDiffs, toolCallId, retained)
    }

    promote(inlineDiffCache, toolCallId, cached)

    return cached.atom
  }

  const retained = retainedDiffs.get(toolCallId)

  if (retained) {
    promote(retainedDiffs, toolCallId, retained)
  }

  const created: CachedToolDiffAtom = {
    atom: atom(retained?.diff ?? ''),
    ...(retained?.sessionId ? { sessionId: retained.sessionId } : {})
  }

  inlineDiffCache.set(toolCallId, created)
  trackMountedAtom(toolCallId, created)
  enforceAtomBudget()

  return created.atom
}

export function clearToolDiffsForSession(sessionId: string): void {
  if (!sessionId) {
    return
  }

  for (const [toolCallId, retained] of retainedDiffs) {
    if (retained.sessionId === sessionId) {
      forgetRetainedDiff(toolCallId)
    }
  }

  for (const [toolCallId, cached] of inlineDiffCache) {
    if (cached.sessionId === sessionId) {
      cached.discarded = true
      cached.atom.set('')
      inlineDiffCache.delete(toolCallId)
    }
  }

  for (const [toolCallId, mounted] of mountedDiffAtoms) {
    if (mounted.sessionId === sessionId) {
      mounted.discarded = true
      mounted.atom.set('')
      mountedDiffAtoms.delete(toolCallId)
    }
  }
}

export function clearAllToolDiffs(): void {
  for (const cached of inlineDiffCache.values()) {
    cached.discarded = true
    cached.atom.set('')
  }

  for (const mounted of mountedDiffAtoms.values()) {
    mounted.discarded = true
    mounted.atom.set('')
  }

  retainedDiffs.clear()
  inlineDiffCache.clear()
  mountedDiffAtoms.clear()
  retainedBytes = 0
}

export function toolDiffRetentionStats(): { atoms: number; bytes: number; entries: number } {
  return {
    atoms: inlineDiffCache.size,
    bytes: retainedBytes,
    entries: retainedDiffs.size
  }
}
