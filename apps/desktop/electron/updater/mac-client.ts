import type { EventEmitter } from 'node:events'
import type { Server } from 'node:http'

import { autoUpdater as nativeUpdater } from 'electron'
import electronUpdater, { type MacUpdater } from 'electron-updater'
import { SemVer } from 'semver'

import feedContract from '../../update-feed.cjs'

import type { ChannelTarget } from './channel'
import { verifyChannelDownload } from './channel-native'
import { channelPublicBase } from './channel-protocol'
import { MacStrategy, type MacStrategyDeps, prepareMacInstall } from './mac'

export interface MacClientDeps extends Omit<MacStrategyDeps, 'updater' | 'prepareInstall' | 'releaseNativeResources'> {
  light: boolean
  feedBaseUrl: string
  /** Exact per-build metadata, not a moving channel directory. */
  feed?: { url: string; channel: string }
  log: (message: string) => void
}

/**
 * electron-updater 6.8.9 (the repository pin) has no public dispose. Its
 * constructor owns two native listeners and its private server serves Squirrel.
 * Capture only the synchronous constructor additions; never clear global events.
 */
export function createOwnedMacUpdater(
  native: Pick<EventEmitter, 'rawListeners' | 'on' | 'removeListener'>,
  create: () => MacUpdater,
  logError: (error: Error) => void
): { updater: MacUpdater; release: () => void; checkForUpdates: MacUpdater['checkForUpdates'] } {
  const events = ['error', 'update-downloaded'] as const
  const before = events.map(event => new Set(native.rawListeners(event)))
  const updater = create()
  const owned = events.map((event, index) => native.rawListeners(event).filter(listener => !before[index].has(listener)))
  const resources = updater as unknown as { server?: Server; squirrelDownloadedUpdate: boolean }
  let attached = true

  const release = (): void => {
    const server = resources.server
    resources.server = undefined

    if (server) {
      server.close(() => {})
      server.closeAllConnections()
    }

    resources.squirrelDownloadedUpdate = false
    events.forEach((event, index) => owned[index].forEach(listener => native.removeListener(event, listener)))
    updater.removeListener('error', logError)
    attached = false
  }

  if (typeof resources.squirrelDownloadedUpdate !== 'boolean') {
    release()
    throw new Error('Unsupported macOS updater resource lifecycle')
  }

  updater.on('error', logError)
  const checkForUpdates = updater.checkForUpdates.bind(updater)
  const ownedCheck: MacUpdater['checkForUpdates'] = () => {
    if (!attached) {
      events.forEach((event, index) => owned[index].forEach(listener => native.on(event, listener)))
      updater.on('error', logError)
      attached = true
    }

    return checkForUpdates()
  }

  return { updater, release, checkForUpdates: ownedCheck }
}

export function createChannelMacStrategy(deps: MacClientDeps, target: ChannelTarget): MacStrategy {
  if (target.package.platform !== 'darwin') {
    throw new Error('Expected macOS channel target')
  }

  return createMacStrategy({
    ...deps,
    channel: target.channel.name,
    feedBaseUrl: target.manifest.request.publicBase,
    feed: { url: target.feedUrl, channel: target.package.feed.channel },
    expectedVersion: target.package.version,
    verifyDownload: (files: string[]): Promise<void> => verifyChannelDownload(files, target.package.artifact)
  })
}

export function createMacStrategy(deps: MacClientDeps): MacStrategy {
  const legacy = feedContract.darwinFeed(deps.channel, deps.light)
  const channel = deps.feed?.channel ?? legacy.channel
  let feed: Parameters<MacUpdater['setFeedURL']>[0] | undefined

  // Validate before construction; a rejected descriptor must not leave the
  // native listeners that MacUpdater installs in its constructor behind.
  if (deps.feed) {
    const base = channelPublicBase(deps.feedBaseUrl)
    const url = new URL(channelPublicBase(deps.feed.url))

    if (!deps.feed.url.startsWith(`${base}/`) || url.origin !== new URL(base).origin) {
      throw new Error('Native feed authority mismatch')
    }

    if (!/^[a-z][a-z0-9-]*$/.test(channel) || !url.pathname.endsWith(`/${channel}-mac.yml`)) {
      throw new Error('Invalid macOS feed descriptor')
    }

    feed = { provider: 'generic', url: new URL('./', url).href, channel }
  } else if (deps.feedBaseUrl) {
    const base = channelPublicBase(deps.feedBaseUrl)
    feed = { provider: 'generic', url: `${base}/${legacy.directory}/`, channel }
  }

  const { updater, release, checkForUpdates } = createOwnedMacUpdater(
    nativeUpdater,
    () => new electronUpdater.MacUpdater(),
    error => deps.log(`macOS updater: ${error.message}`)
  )

  if (deps.feed) {
    // The validated channel sequence, not SemVer precedence, decides whether a
    // pinned build is newer. Build metadata is intentionally precedence-neutral.
    Object.defineProperty(updater, 'currentVersion', {
      value: new SemVer('0.0.0'),
      configurable: true
    })
  }

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.autoRunAppAfterInstall = true
  updater.channel = channel
  updater.allowPrerelease = deps.feed ? Boolean(deps.expectedVersion?.includes('-')) : legacy.allowPrerelease
  // Setting channel enables downgrades in electron-updater. This app never does.
  updater.allowDowngrade = false
  if (feed) {
    try {
      updater.setFeedURL(feed)
    } catch (error) {
      release()
      throw error
    }
  }

  return new MacStrategy({
    ...deps,
    updater: {
      checkForUpdates,
      downloadUpdate: updater.downloadUpdate.bind(updater),
      quitAndInstall: updater.quitAndInstall.bind(updater),
      on: updater.on.bind(updater),
      removeListener: updater.removeListener.bind(updater)
    },
    prepareInstall: () => prepareMacInstall(nativeUpdater),
    releaseNativeResources: release
  })
}
