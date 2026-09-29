import { beforeEach, describe, expect, it } from 'vitest'

import {
  $toolInlineDiff,
  clearAllToolDiffs,
  clearToolDiffsForSession,
  getToolDiff,
  MAX_RETAINED_TOOL_DIFF_ATOMS,
  MAX_RETAINED_TOOL_DIFF_BYTES,
  MAX_RETAINED_TOOL_DIFF_ENTRIES,
  recordToolDiff,
  toolDiffRetentionStats
} from './tool-diffs'

describe('tool-diffs per-tool subscriptions', () => {
  beforeEach(() => clearAllToolDiffs())

  it('returns a stable cached atom per toolCallId', () => {
    expect($toolInlineDiff('a')).toBe($toolInlineDiff('a'))
    expect($toolInlineDiff('a')).not.toBe($toolInlineDiff('b'))
  })

  it('notifies only the tool whose diff changed', () => {
    const aCalls: string[] = []
    const bCalls: string[] = []
    const unsubA = $toolInlineDiff('notify-a').listen(v => aCalls.push(v))
    const unsubB = $toolInlineDiff('notify-b').listen(v => bCalls.push(v))

    recordToolDiff('notify-a', 'diffA')
    expect(aCalls).toEqual(['diffA'])
    expect(bCalls).toEqual([]) // the unrelated tool row is never notified

    recordToolDiff('notify-b', 'diffB')
    expect(aCalls).toEqual(['diffA']) // still not re-notified
    expect(bCalls).toEqual(['diffB'])

    unsubA()
    unsubB()
  })

  it('does not re-notify when the same diff is recorded again', () => {
    const calls: string[] = []
    const unsub = $toolInlineDiff('same').listen(v => calls.push(v))

    recordToolDiff('same', 'x')
    recordToolDiff('same', 'x')

    expect(calls).toEqual(['x'])
    unsub()
  })

  it('reads the current diff for a tool and empty for unknown/blank ids', () => {
    recordToolDiff('read-me', 'value')
    expect(getToolDiff('read-me')).toBe('value')
    expect(getToolDiff('missing')).toBe('')
    expect(getToolDiff('')).toBe('')
    expect($toolInlineDiff('').get()).toBe('')
  })

  it('bounds strings and per-tool atoms with deterministic LRU eviction', () => {
    const mounted = $toolInlineDiff('mounted-oldest')
    const unmount = mounted.listen(() => undefined)

    for (let index = 0; index <= MAX_RETAINED_TOOL_DIFF_ATOMS; index += 1) {
      $toolInlineDiff(`atom-only-${index}`)
    }

    // A live subscriber still receives its completion after cache pressure.
    recordToolDiff('mounted-oldest', 'still painted')
    recordToolDiff('recent', 'recent')

    for (let index = 0; index < MAX_RETAINED_TOOL_DIFF_ENTRIES - 2; index += 1) {
      const id = `many-${index}`
      recordToolDiff(id, `diff-${index}`)
      $toolInlineDiff(id)
    }

    // A read promotes this entry; the untouched oldest entry is evicted first.
    expect(getToolDiff('recent')).toBe('recent')
    recordToolDiff('overflow', 'overflow')

    expect(getToolDiff('mounted-oldest')).toBe('')
    expect(getToolDiff('recent')).toBe('recent')
    expect(mounted.get()).toBe('still painted')
    expect($toolInlineDiff('mounted-oldest')).toBe(mounted)

    let stats = toolDiffRetentionStats()
    expect(stats.entries).toBeLessThanOrEqual(MAX_RETAINED_TOOL_DIFF_ENTRIES)
    expect(stats.atoms).toBeLessThanOrEqual(MAX_RETAINED_TOOL_DIFF_ATOMS)

    unmount()
    clearAllToolDiffs()
    const oversizedMounted = $toolInlineDiff('oversized')
    const unmountOversized = oversizedMounted.listen(() => undefined)
    const oversized = 'x'.repeat(MAX_RETAINED_TOOL_DIFF_BYTES + 1)
    recordToolDiff('oversized', oversized)

    expect(oversizedMounted.get()).toBe(oversized)
    expect(getToolDiff('oversized')).toBe('')
    expect(toolDiffRetentionStats()).toEqual({ atoms: 0, bytes: 0, entries: 0 })

    const halfBudget = 'y'.repeat(Math.floor(MAX_RETAINED_TOOL_DIFF_BYTES / 2) + 1)
    recordToolDiff('byte-oldest', halfBudget)
    recordToolDiff('byte-newest', halfBudget)

    stats = toolDiffRetentionStats()
    expect(getToolDiff('byte-oldest')).toBe('')
    expect(getToolDiff('byte-newest')).toBe(halfBudget)
    expect(stats.bytes).toBeLessThanOrEqual(MAX_RETAINED_TOOL_DIFF_BYTES)
    unmountOversized()
  })

  it('cleans only diffs and atoms owned by the removed session', () => {
    const removed = $toolInlineDiff('removed-tool')
    const retained = $toolInlineDiff('retained-tool')
    recordToolDiff('removed-tool', 'removed diff', 'session-a')
    recordToolDiff('retained-tool', 'retained diff', 'session-b')

    clearToolDiffsForSession('session-a')

    expect(removed.get()).toBe('')
    expect(getToolDiff('removed-tool')).toBe('')
    expect(toolDiffRetentionStats()).toEqual({
      atoms: 1,
      bytes: new TextEncoder().encode('retained diff').byteLength,
      entries: 1
    })
    expect(retained.get()).toBe('retained diff')
    expect(getToolDiff('retained-tool')).toBe('retained diff')
  })
})
