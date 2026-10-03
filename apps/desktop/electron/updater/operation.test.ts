import { expect, test } from 'vitest'

import { UpdateOperation } from './operation'

import type { UpdaterApplyResultWire, UpdaterStrategy } from './index'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise: Promise<T> = new Promise<T>((done, fail): void => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

function strategy(): UpdaterStrategy {
  return {
    mechanism: 'external',
    check: async () => ({ supported: false }),
    apply: async () => ({ ok: true })
  }
}

test('check and apply share one pending strategy, and a failed initialization can retry', async (): Promise<void> => {
  const pending = deferred<UpdaterStrategy | null>()
  const installed: UpdaterStrategy = strategy()
  let attempts: number = 0

  const operation = new UpdateOperation((): Promise<UpdaterStrategy | null> => {
    attempts += 1

    return attempts === 1 ? pending.promise : Promise.resolve(installed)
  })

  const first: Promise<UpdaterStrategy | null> = operation.resolve()
  const second: Promise<UpdaterStrategy | null> = operation.resolve()
  expect(attempts).toBe(1)
  const failures = Promise.allSettled([first, second])
  pending.reject(new Error('native inspection failed'))
  expect((await failures).map((result): string => result.status)).toEqual(['rejected', 'rejected'])
  expect(await operation.resolve()).toBe(installed)
  expect(await operation.resolve()).toBe(installed)
  expect(attempts).toBe(2)
})

test('apply ownership precedes async resolution, survives restoration, and retains a successful handoff', async (): Promise<void> => {
  const pending = deferred<UpdaterStrategy | null>()
  const operation = new UpdateOperation((): Promise<UpdaterStrategy | null> => pending.promise)
  const restoration = deferred()
  const restoring = deferred()
  let applications: number = 0

  const first: Promise<UpdaterApplyResultWire> = operation.apply(async (): Promise<UpdaterApplyResultWire> => {
    applications += 1
    await operation.resolve()
    restoring.resolve()
    await restoration.promise
    throw new Error('install failed')
  })

  const competing: Promise<UpdaterApplyResultWire> = operation.apply(async () => ({ ok: true }))
  const rejected = expect(competing).rejects.toThrow('already in progress')
  pending.resolve(strategy())
  await rejected
  await restoring.promise
  await expect(operation.apply(async () => ({ ok: true }))).rejects.toThrow('already in progress')
  restoration.resolve()
  await expect(first).rejects.toThrow('install failed')
  expect(applications).toBe(1)
  await expect(operation.apply(async () => ({ ok: false }))).resolves.toEqual({ ok: false })
  await expect(operation.apply(async () => ({ ok: true, handedOff: true }))).resolves.toEqual({
    ok: true,
    handedOff: true
  })
  await expect(operation.apply(async () => ({ ok: true }))).rejects.toThrow('already in progress')
})

test('explicit preparation coalesces for its window and owns the selection until apply or cancellation', async (): Promise<void> => {
  const operation = new UpdateOperation(async () => strategy())
  const ready = deferred<boolean>()
  let preparations: number = 0
  let applications: number = 0
  const prepare = (): Promise<boolean> => {
    preparations += 1

    return ready.promise
  }
  const first = operation.prepare(prepare, 1)
  expect(operation.prepare(prepare, 1)).toBe(first)
  await expect(operation.prepare(prepare, 2)).rejects.toThrow('already in progress')
  await expect(operation.apply(async () => ({ ok: true }), 2)).rejects.toThrow('already in progress')
  const apply = operation.apply(async () => {
    applications += 1

    return { ok: true }
  }, 1)
  await Promise.resolve()
  expect(applications).toBe(0)
  ready.resolve(true)
  expect(await first).toBe(true)
  await apply
  expect(preparations).toBe(1)
  expect(applications).toBe(1)
  expect(await operation.prepare(async () => true, 1)).toBe(true)
  await expect(operation.apply(async () => ({ ok: true }), 2)).rejects.toThrow('already in progress')
  let released: boolean = false
  await operation.cancelPreparation(1, (): void => { released = true })
  expect(released).toBe(true)
  await expect(operation.apply(async () => ({ ok: true }), 2)).resolves.toEqual({ ok: true })
})

test('failed preparation releases window ownership and permits a new explicit attempt', async (): Promise<void> => {
  const operation = new UpdateOperation(async () => strategy())
  await expect(operation.prepare(async () => { throw new Error('download rejected') }, 1)).rejects.toThrow('download rejected')
  expect(await operation.prepare(async () => false, 2)).toBe(false)
  await expect(operation.apply(async () => ({ ok: true }), 3)).resolves.toEqual({ ok: true })
})
