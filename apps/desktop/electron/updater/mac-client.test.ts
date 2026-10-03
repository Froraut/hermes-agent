import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'

import type { MacUpdater } from 'electron-updater'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { client } = vi.hoisted(() => ({
  client: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    channel: '',
    allowPrerelease: true,
    allowDowngrade: true,
    currentVersion: { version: '9.9.9' },
    squirrelDownloadedUpdate: false,
    on: vi.fn(),
    removeListener: vi.fn(),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => null)
  }
}))

vi.mock('electron', () => ({ autoUpdater: { rawListeners: () => [], on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('electron-updater', () => ({
  default: {
    MacUpdater: class {
      constructor() {
        return client
      }
    }
  }
}))

import { createMacStrategy, createOwnedMacUpdater } from './mac-client'

afterEach((): void => {
  vi.clearAllMocks()
  client.currentVersion = { version: '9.9.9' }
})

function deps(
  feedBaseUrl = '',
  light = false,
  channel: 'stable' | 'canary' = 'stable'
): Parameters<typeof createMacStrategy>[0] {
  return {
    channel,
    light,
    feedBaseUrl,
    appVersion: '0.28.0',
    log: vi.fn(),
    emitProgress: vi.fn(),
    beforeInstall: vi.fn(),
    onInstallFailure: vi.fn()
  }
}

describe('macOS client wiring', () => {
  it('closes only its proxy and constructor listeners, and reattaches its own handlers for retry', async () => {
    const native = new EventEmitter()
    const unrelatedError = vi.fn()
    const unrelatedReady = vi.fn()
    const laterError = vi.fn()
    native.on('error', unrelatedError)
    native.on('update-downloaded', unrelatedReady)
    const server = createServer((_request, response) => response.end('owned proxy'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const logError = vi.fn()
    const updater = Object.assign(new EventEmitter(), {
      server,
      squirrelDownloadedUpdate: true,
      checkForUpdates: vi.fn(async () => null)
    })
    const ownedError = (error: Error): void => { updater.emit('error', error) }
    const ownedReady = (): void => { updater.squirrelDownloadedUpdate = true }
    const owner = createOwnedMacUpdater(native, () => {
      native.on('error', ownedError)
      native.on('update-downloaded', ownedReady)

      return updater as unknown as MacUpdater
    }, logError)

    try {
      native.on('error', laterError)
      const closed = once(server, 'close')
      owner.release()
      await closed
      expect(server.listening).toBe(false)
      expect(updater.server).toBeUndefined()
      expect(updater.squirrelDownloadedUpdate).toBe(false)
      expect(native.listeners('error')).toEqual([unrelatedError, laterError])
      expect(native.listeners('update-downloaded')).toEqual([unrelatedReady])
      native.emit('error', new Error('unrelated native event'))
      expect(logError).not.toHaveBeenCalled()

      await owner.checkForUpdates()
      native.emit('update-downloaded')
      expect(updater.squirrelDownloadedUpdate).toBe(true)
      native.emit('error', new Error('retry native event'))
      expect(logError).toHaveBeenCalledOnce()
      expect(unrelatedError).toHaveBeenCalledTimes(2)
      expect(laterError).toHaveBeenCalledTimes(2)
      owner.release()
      expect(native.listeners('error')).toEqual([unrelatedError, laterError])
    } finally {
      owner.release()
      if (server.listening) {
        const closed = once(server, 'close')
        server.close()
        await closed
      }
    }
  })

  it('uses the generated provider by default and forbids implicit installs or downgrades', async () => {
    const strategy = createMacStrategy(deps())
    expect(client.setFeedURL).not.toHaveBeenCalled()
    await expect(strategy.check()).rejects.toThrow('not active')
    expect(client.autoDownload).toBe(false)
    expect(client.autoInstallOnAppQuit).toBe(false)
    expect(client.autoRunAppAfterInstall).toBe(true)
    expect(client.allowDowngrade).toBe(false)
    expect(client.channel).toBe('stable')
    expect(client.allowPrerelease).toBe(false)
  })

  it('pins a neutral immutable descriptor instead of interpolating the dynamic name', (): void => {
    createMacStrategy({
      ...deps('https://updates.example'),
      channel: 'unknown-preview',
      feed: { url: 'https://updates.example/releases/channel-builds/abc/darwin/latest-mac.yml', channel: 'latest' }
    })
    expect(client.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example/releases/channel-builds/abc/darwin/',
      channel: 'latest'
    })
    expect(client.allowDowngrade).toBe(false)
    expect(client.currentVersion.version).toBe('0.0.0')
    expect(client.autoDownload).toBe(false)
    expect((): void => {
      createMacStrategy({
        ...deps('https://updates.example'),
        feed: { url: 'https://other.example/latest-mac.yml', channel: 'latest' }
      })
    }).toThrow('authority')
  })

  it('checks a newer channel head when SemVer build metadata has equal precedence', async (): Promise<void> => {
    const version = '0.21.4+canary.20260922T001500Z'
    client.checkForUpdates.mockImplementationOnce(async () => {
      expect(client.currentVersion.version).toBe('0.0.0')
      const info = { version, files: [], releaseDate: '', path: '', sha512: '' }

      return { isUpdateAvailable: true, updateInfo: info, versionInfo: info }
    })

    const strategy = createMacStrategy({
      ...deps('https://updates.example', false, 'canary'),
      appVersion: '0.21.4+canary.20260922T001400Z',
      expectedVersion: version,
      feed: {
        url: 'https://updates.example/releases/channel-builds/abc/darwin/latest-mac.yml',
        channel: 'latest'
      }
    })

    await expect(strategy.check()).resolves.toMatchObject({ updateAvailable: true, latestTag: `v${version}` })
  })

  it('overrides the provider with the same variant/channel path as the publisher', () => {
    createMacStrategy(deps('https://updates.example/', true, 'canary'))
    expect(client.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example/releases/darwin/light/canary/',
      channel: 'canary'
    })
    expect(client.allowPrerelease).toBe(true)
    expect(() => createMacStrategy(deps('http://untrusted.example'))).toThrow('HTTPS')
  })
})
