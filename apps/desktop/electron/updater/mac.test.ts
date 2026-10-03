import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifyChannelDownload } from './channel-native'
import { MacStrategy, type MacStrategyDeps, prepareMacInstall } from './mac'

function fixture() {
  const events: string[] = []
  const emitter = new EventEmitter()
  const info = { version: '0.29.0', files: [], releaseDate: '', path: '', sha512: '' }

  const deps: MacStrategyDeps = {
    updater: {
      checkForUpdates: vi.fn(async () => {
        events.push('check')

        return { isUpdateAvailable: true, updateInfo: info, versionInfo: info }
      }),
      downloadUpdate: vi.fn(async () => {
        events.push('download')

        return []
      }),
      quitAndInstall: vi.fn(() => {
        events.push('install')
      }),
      on: emitter.on.bind(emitter) as MacStrategyDeps['updater']['on'],
      removeListener: emitter.removeListener.bind(emitter) as MacStrategyDeps['updater']['removeListener']
    },
    channel: 'canary',
    appVersion: '0.28.0',
    prepareInstall: vi.fn(async () => {
      events.push('verify')
    }),
    beforeInstall: vi.fn(async () => {
      events.push('stop')
    }),
    onInstallFailure: vi.fn(async () => {
      events.push('restore')
    }),
    emitProgress: vi.fn()
  }

  return { deps, events, emitter, strategy: new MacStrategy(deps) }
}

afterEach(() => vi.useRealTimers())

describe('macOS strategy', () => {
  it('reuses only the pinned release check and still verifies before teardown', async () => {
    const legacy = fixture()
    await legacy.strategy.check()
    expect(await legacy.strategy.prepare()).toBe(false)
    await legacy.strategy.apply()
    expect(legacy.events).toEqual(['check', 'check', 'download', 'verify', 'stop', 'install'])

    const { deps, strategy, events, emitter } = fixture()
    deps.expectedVersion = '0.29.0'
    deps.verifyDownload = vi.fn(async () => {
      events.push('hash')
    })
    expect(await strategy.check()).toMatchObject({ channel: 'canary', latestTag: 'v0.29.0', updateAvailable: true })
    expect(deps.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(await strategy.apply()).toMatchObject({ ok: true, handedOff: true })
    expect(events).toEqual(['check', 'download', 'hash', 'verify', 'stop', 'install'])
    expect(deps.updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(emitter.listenerCount('download-progress')).toBe(0)
  })

  it('invalidates pinned availability after failed or unavailable rechecks and retries safely', async () => {
    const { deps, strategy, events } = fixture()
    deps.expectedVersion = '0.29.0'
    await strategy.check()
    vi.mocked(deps.updater.checkForUpdates).mockRejectedValueOnce(new Error('feed offline'))
    await expect(strategy.check()).rejects.toThrow('feed offline')
    vi.mocked(deps.updater.checkForUpdates).mockRejectedValueOnce(new Error('feed still offline'))
    await expect(strategy.apply()).rejects.toThrow('feed still offline')
    expect(deps.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(events).not.toContain('stop')

    const info = { version: '0.29.0', files: [], releaseDate: '', path: '', sha512: '' }
    vi.mocked(deps.updater.checkForUpdates).mockResolvedValueOnce({
      isUpdateAvailable: false,
      updateInfo: info,
      versionInfo: info
    })
    expect((await strategy.check()).updateAvailable).toBe(false)
    vi.mocked(deps.updater.checkForUpdates).mockRejectedValueOnce(new Error('feed unavailable'))
    await expect(strategy.apply()).rejects.toThrow('feed unavailable')
    expect(deps.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(events).not.toContain('stop')

    expect(await strategy.apply()).toMatchObject({ ok: true, handedOff: true })
    expect(deps.updater.checkForUpdates).toHaveBeenCalledTimes(6)
    expect(deps.updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(events.slice(-4)).toEqual(['download', 'verify', 'stop', 'install'])
  })

  it('joins explicit preparation without downloading twice or stopping the usable backend early', async () => {
    const { deps, strategy, events } = fixture()
    deps.expectedVersion = '0.29.0'
    deps.verifyDownload = vi.fn(async () => {
      events.push('hash')
    })
    let completeDownload!: (files: string[]) => void
    vi.mocked(deps.updater.downloadUpdate).mockImplementation(() => {
      events.push('download')

      return new Promise(resolve => {
        completeDownload = resolve
      })
    })

    await strategy.check()
    const first = strategy.prepare()
    const second = strategy.prepare()
    await vi.waitFor(() => expect(deps.updater.downloadUpdate).toHaveBeenCalledOnce())
    expect(deps.beforeInstall).not.toHaveBeenCalled()
    expect(deps.emitProgress).not.toHaveBeenCalled()
    await expect(strategy.check()).rejects.toThrow('already in progress')

    const applying = strategy.apply()
    completeDownload(['pinned.zip'])
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(await applying).toMatchObject({ ok: true, handedOff: true })
    expect(deps.updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(events).toEqual(['check', 'download', 'hash', 'verify', 'hash', 'stop', 'install'])
  })

  it('rereads prepared artifact bytes before stopping and refreshes preparation after rejection', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hermes-mac-prepared-'))

    try {
      const file = path.join(directory, 'pinned.zip')
      const bytes = Buffer.from('accept')
      await writeFile(file, bytes)
      const { deps, strategy } = fixture()
      deps.expectedVersion = '0.29.0'
      deps.releaseNativeResources = vi.fn()
      deps.verifyDownload = files =>
        verifyChannelDownload(files, {
          key: 'pinned.zip',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
      vi.mocked(deps.updater.downloadUpdate).mockResolvedValue([file])

      expect(await strategy.prepare()).toBe(true)
      expect(deps.prepareInstall).toHaveBeenCalledOnce()
      expect(deps.beforeInstall).not.toHaveBeenCalled()
      await writeFile(file, 'reject')
      await expect(strategy.apply()).rejects.toThrow('digest mismatch')
      expect(deps.releaseNativeResources).toHaveBeenCalledOnce()
      expect(deps.beforeInstall).not.toHaveBeenCalled()
      expect(deps.updater.quitAndInstall).not.toHaveBeenCalled()

      await writeFile(file, bytes)
      expect(await strategy.apply()).toMatchObject({ ok: true, handedOff: true })
      expect(deps.updater.checkForUpdates).toHaveBeenCalledTimes(2)
      expect(deps.updater.downloadUpdate).toHaveBeenCalledTimes(2)
      expect(deps.prepareInstall).toHaveBeenCalledTimes(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('releases prepared admission on cancellation and prepares afresh before retry', async () => {
    const { deps, strategy } = fixture()
    deps.expectedVersion = '0.29.0'
    deps.verifyDownload = vi.fn(async () => {})
    deps.releaseNativeResources = vi.fn()
    expect(await strategy.prepare()).toBe(true)
    strategy.releasePreparation()
    expect(deps.releaseNativeResources).toHaveBeenCalledOnce()
    expect(deps.beforeInstall).not.toHaveBeenCalled()
    expect(await strategy.apply()).toMatchObject({ ok: true, handedOff: true })
    expect(deps.updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(deps.updater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(deps.prepareInstall).toHaveBeenCalledTimes(2)
  })

  it.each(['downloadUpdate', 'prepareInstall'] as const)('keeps backends alive on %s failure', async failure => {
    const { deps, strategy, events, emitter } = fixture()
    vi.mocked(failure === 'downloadUpdate' ? deps.updater.downloadUpdate : deps.prepareInstall).mockRejectedValueOnce(
      new Error('invalid update')
    )
    await expect(strategy.apply()).rejects.toThrow('invalid update')
    expect(events).not.toContain('stop')
    expect(events).not.toContain('install')
    expect(emitter.listenerCount('download-progress')).toBe(0)
  })

  it('does not install when the provider reports no newer release', async () => {
    const { deps, strategy, events } = fixture()
    const info = { version: '0.27.0', files: [], releaseDate: '', path: '', sha512: '' }
    vi.mocked(deps.updater.checkForUpdates).mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: info,
      versionInfo: info
    })
    await strategy.apply()
    expect(events).toEqual([])
    expect(deps.updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('refuses a substituted pinned version or artifact before native signature preparation', async (): Promise<void> => {
    const { deps, events } = fixture()
    deps.expectedVersion = '0.30.0'
    await expect(new MacStrategy(deps).apply()).rejects.toThrow('pinned channel version')
    expect(events).toEqual(['check'])
    deps.expectedVersion = '0.29.0'

    deps.verifyDownload = async (): Promise<void> => {
      throw new Error('artifact digest mismatch')
    }

    await expect(new MacStrategy(deps).apply()).rejects.toThrow('artifact digest')
    expect(events).not.toContain('verify')
    expect(events).not.toContain('stop')
  })

  it('restores the backend if install handoff throws', async () => {
    const { deps, strategy, events } = fixture()
    vi.mocked(deps.updater.quitAndInstall).mockImplementation(() => {
      throw new Error('handoff failed')
    })
    await expect(strategy.apply()).rejects.toThrow('handoff failed')
    expect(events.slice(-2)).toEqual(['stop', 'restore'])
  })

  it('preserves the handoff error when backend recovery also fails', async (): Promise<void> => {
    const { deps, strategy, emitter } = fixture()
    const handoff = new Error('native handoff failed')
    const recovery = new Error('backend recovery failed')
    vi.mocked(deps.updater.quitAndInstall).mockImplementation((): never => {
      throw handoff
    })
    vi.mocked(deps.onInstallFailure).mockRejectedValue(recovery)
    await expect(strategy.apply()).rejects.toMatchObject({ cause: handoff, errors: [handoff, recovery] })
    expect(deps.emitProgress).toHaveBeenLastCalledWith({
      stage: 'error',
      message: 'native handoff failed; backend recovery failed',
      percent: null
    })
    expect(emitter.listenerCount('download-progress')).toBe(0)
  })

  it('rejects simultaneous apply calls', async () => {
    const { deps, strategy } = fixture()
    let release!: () => void
    vi.mocked(deps.prepareInstall).mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const applying = strategy.apply()
    await vi.waitFor(() => expect(deps.prepareInstall).toHaveBeenCalledOnce())
    await expect(strategy.apply()).rejects.toThrow('already in progress')
    await expect(strategy.check()).rejects.toThrow('already in progress')
    release()
    await applying
  })
})

describe('native signature verification', () => {
  it('waits for native readiness and removes both listeners', async () => {
    const native = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() })
    let ready = false

    const pending = prepareMacInstall(native).then(() => {
      ready = true
    })

    await Promise.resolve()
    expect(ready).toBe(false)
    native.emit('update-downloaded')
    await pending
    expect(native.listenerCount('error')).toBe(0)
    expect(native.listenerCount('update-downloaded')).toBe(0)
  })

  it('surfaces native rejection and bounds a missing readiness event', async () => {
    vi.useFakeTimers()
    const native = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() })
    const rejected = expect(prepareMacInstall(native)).rejects.toThrow('bad signature')
    native.emit('error', new Error('bad signature'))
    await rejected
    const timeout = expect(prepareMacInstall(native, 2000)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(2000)
    await timeout
    expect(native.listenerCount('error')).toBe(0)
    expect(native.listenerCount('update-downloaded')).toBe(0)
  })
})
