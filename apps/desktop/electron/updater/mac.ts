import type { AppUpdater } from 'electron-updater'

import { applyPackagedHandoff } from './packaged-handoff'

import type { UpdaterApplyResultWire, UpdaterStatusWire, UpdaterStrategy } from './index'

export interface MacStrategyDeps {
  updater: Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on' | 'removeListener'>
  channel: string
  expectedVersion?: string
  verifyDownload?: (files: string[]) => Promise<void>
  appVersion: string
  /** Squirrel verifies the signed app before any backend is stopped. */
  prepareInstall: () => Promise<void>
  /** The operation owner joins preparation before releasing its native resources. */
  releaseNativeResources?: () => void
  beforeInstall: () => Promise<void>
  onInstallFailure: () => Promise<void>
  emitProgress: (payload: { stage: string; message: string; percent: number | null }) => void
}

interface PreparedMacUpdate {
  version: string
  status: UpdaterStatusWire
  files: string[]
}

export class MacStrategy implements UpdaterStrategy {
  readonly mechanism = 'electron-updater' as const
  private applying = false
  private checkedPinnedRelease: UpdaterStatusWire | null = null
  private preparation: Promise<PreparedMacUpdate | null> | null = null
  private prepared: PreparedMacUpdate | null = null

  constructor(private readonly deps: MacStrategyDeps) {}

  async check(): Promise<UpdaterStatusWire> {
    if (this.applying || this.preparation) {
      throw new Error('An update is already in progress.')
    }

    try {
      return await this.checkRelease()
    } catch (error) {
      this.releasePreparation()
      throw error
    }
  }

  private async checkRelease(): Promise<UpdaterStatusWire> {
    // A failed or unavailable recheck cannot authorize an older selection.
    this.checkedPinnedRelease = null
    const prepared = this.prepared
    this.prepared = null
    const result = await this.deps.updater.checkForUpdates()

    if (!result) {
      throw new Error('The macOS updater is not active for this app.')
    }

    if (this.deps.expectedVersion && result.updateInfo.version !== this.deps.expectedVersion) {
      throw new Error('Native macOS feed does not match the pinned channel version')
    }

    const status: UpdaterStatusWire = {
      supported: true,
      mechanism: this.mechanism,
      currentVersion: this.deps.appVersion,
      channel: this.deps.channel,
      latestTag: `v${result.updateInfo.version}`,
      updateAvailable: result.isUpdateAvailable,
      fetchedAt: Date.now()
    }

    if (this.deps.expectedVersion && status.updateAvailable) {
      this.checkedPinnedRelease = status

      if (prepared?.version === this.deps.expectedVersion) {
        this.prepared = prepared
      }
    }

    return status
  }

  private pinnedStatus(): UpdaterStatusWire | null {
    return this.deps.expectedVersion && this.checkedPinnedRelease?.latestTag === `v${this.deps.expectedVersion}`
      ? this.checkedPinnedRelease
      : null
  }

  /** Explicit update intent may prepare a pinned package while Hermes stays usable. */
  async prepare(): Promise<boolean> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    const version = this.deps.expectedVersion

    // Moving feeds have no admitted immutable artifact to stage ahead of Apply.
    if (!version || !this.deps.verifyDownload) {
      return false
    }

    if (this.prepared?.version === version) {
      return true
    }

    this.preparation ??= this.preparePinned(version)
      .then((prepared: PreparedMacUpdate | null): PreparedMacUpdate | null => {
        this.prepared = prepared

        return prepared
      })
      .catch((error: unknown): never => {
        this.releasePreparation()
        throw error
      })
      .finally((): void => {
        this.preparation = null
      })

    return (await this.preparation) !== null
  }

  /** Called after the owner has joined preparation, or by this operation's failure path. */
  releasePreparation(): void {
    this.checkedPinnedRelease = null
    this.prepared = null
    this.deps.releaseNativeResources?.()
  }

  private async preparePinned(version: string): Promise<PreparedMacUpdate | null> {
    const status = this.pinnedStatus() ?? (await this.checkRelease())

    if (!status.updateAvailable) {
      return null
    }

    const files = await this.deps.updater.downloadUpdate()
    await this.deps.verifyDownload!(files)
    await this.deps.prepareInstall()

    return { version, status, files }
  }

  async apply(): Promise<UpdaterApplyResultWire> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    this.applying = true

    const progress = ({ percent }: { percent: number }): void => {
      this.deps.emitProgress({ stage: 'fetch', message: 'Downloading the Hermes update.', percent })
    }

    this.deps.updater.on('download-progress', progress)

    try {
      return await applyPackagedHandoff(
        {
          teardown: this.deps.beforeInstall,
          restore: this.deps.onInstallFailure,
          emitProgress: this.deps.emitProgress
        },
        async (stop: () => Promise<void>): Promise<UpdaterApplyResultWire> => {
          const preparation = this.preparation ? await this.preparation : this.prepared
          const prepared = preparation?.version === this.deps.expectedVersion ? preparation : null
          // The channel pins this native instance to one immutable build. Its
          // admitted metadata already selects the download; legacy feeds move.
          const status = prepared?.status ?? this.pinnedStatus() ?? (await this.checkRelease())

          if (!status.updateAvailable) {
            return { ok: true, mechanism: this.mechanism }
          }

          if (prepared) {
            // Staging can precede remote work by minutes; reread the admitted
            // file before stopping anything, even after native preparation.
            this.deps.emitProgress({ stage: 'prepare', message: 'Verifying the prepared macOS update.', percent: null })
            await this.deps.verifyDownload!(prepared.files)
          } else {
            const files = await this.deps.updater.downloadUpdate()
            await this.deps.verifyDownload?.(files)
            this.deps.emitProgress({ stage: 'prepare', message: 'Verifying the signed macOS update.', percent: null })
            await this.deps.prepareInstall()
          }
          await stop()
          this.deps.emitProgress({
            stage: 'restart',
            message: 'Restarting Hermes to install the update.',
            percent: 100
          })
          this.deps.updater.quitAndInstall()

          return { ok: true, bundled: true, handedOff: true, mechanism: this.mechanism }
        }
      )
    } catch (error) {
      this.releasePreparation()
      throw error
    } finally {
      this.deps.updater.removeListener('download-progress', progress)
      this.applying = false
    }
  }
}

export interface NativeMacUpdater {
  once(event: 'update-downloaded', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'update-downloaded', listener: () => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): void
}

/** Download completion alone does not mean Squirrel accepted the signature. */
export function prepareMacInstall(native: NativeMacUpdater, timeoutMs: number = 120_000): Promise<void> {
  return new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    const cleanup = (): void => {
      clearTimeout(timer)
      native.removeListener('error', failed)
      native.removeListener('update-downloaded', ready)
    }

    const failed = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const ready = (): void => {
      cleanup()
      resolve()
    }

    const timer = setTimeout((): void => failed(new Error('macOS update verification timed out.')), timeoutMs)
    native.once('error', failed)
    native.once('update-downloaded', ready)

    try {
      native.checkForUpdates()
    } catch (error) {
      failed(error as Error)
    }
  })
}
