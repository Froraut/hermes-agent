import { createHash } from 'node:crypto'

import type { ChannelResolver, ChannelTarget } from './channel'
import type { ChannelBuild } from './channel-protocol'

import type { UpdaterApplyResultWire, UpdaterStatusWire, UpdaterStrategy } from './index'

export interface ChannelRetirementStatus {
  state: 'discontinued'
  destination: string
  version: string
  message?: string
}
export interface ChannelStrategyDeps {
  resolver: Pick<ChannelResolver, 'resolve'>
  build: ChannelBuild
  mechanism: 'electron-updater' | 'app-installer'
  nativeFactory: (target: ChannelTarget) => UpdaterStrategy
}
interface NativeSelection {
  kind: 'native'
  identity: string
  strategy: UpdaterStrategy
  available: boolean
  status: UpdaterStatusWire
}
interface RetirementSelection {
  kind: 'retirement'
  value: unknown
  state: ChannelRetirementStatus['state']
}
type Selection = NativeSelection | RetirementSelection | { kind: 'empty' }

/** One selection owns a check/apply operation; background checks cannot retarget it. */
export class ChannelStrategy implements UpdaterStrategy {
  readonly mechanism: ChannelStrategyDeps['mechanism']
  private selection: Selection | null = null
  private busy = false
  private prepared = false

  constructor(private readonly deps: ChannelStrategyDeps) {
    this.mechanism = deps.mechanism
  }

  private enter(): void {
    if (this.busy) {
      throw new Error('An update operation is already in progress.')
    }

    this.busy = true
  }

  async check(): Promise<UpdaterStatusWire> {
    // An explicit update request owns its admitted target until Apply/cancel.
    // Return its original timestamp rather than retargeting a staged package.
    if (this.prepared && this.selection?.kind === 'native') {
      return { ...this.selection.status }
    }

    this.enter()

    try {
      return await this.select()
    } finally {
      this.busy = false
    }
  }

  private async select(): Promise<UpdaterStatusWire> {
    // Failed reads invalidate prior availability, never leave a stale install action.
    const previous = this.selection
    this.selection = null
    try {
      const result = await this.deps.resolver.resolve()

      const base: UpdaterStatusWire = {
        supported: true,
        mechanism: this.mechanism,
        channel: this.deps.build.channel,
        currentVersion: this.deps.build.version,
        fetchedAt: Date.now()
      }

      if (result.kind === 'empty') {
        this.selection = { kind: 'empty' }

        return { ...base, updateAvailable: false, reason: 'no-build-published' }
      }

      if (result.kind === 'retirement') {
        // In-place retirement IS a same-identity update to the pinned stable
        // build: run it through the native factory (app-installer/electron-updater
        // available → download → apply), identical to a stable update. The
        // suffixed-identity tier never updates at all.
        if (result.retirement.receiverKind === 'in-place') {
          // Sequence counters are per-channel; a retired preview's sequence says
          // nothing about the pinned stable build. The native strategy's own
          // version comparison decides availability, exactly as for stable.
          return await this.selectNative(base, result.retirement.target, { crossChannel: true, previous })
        }

        // Discontinued (suffixed identity): notice only. No migration callbacks,
        // no download — the user uninstalls; data stays on disk.
        this.selection = { kind: 'retirement', value: result.retirement, state: 'discontinued' }

        return {
          ...base,
          retirement: {
            state: 'discontinued',
            destination: result.retirement.target.channel.name,
            version: result.retirement.target.manifest.request.version
          }
        }
      }

      return await this.selectNative(base, result.target, { previous })
    } finally {
      // Identical targets retain their adapter. Every other selection path,
      // including a failed resolver, releases the adapter it made unreachable.
      if (previous?.kind === 'native' &&
          (this.selection?.kind !== 'native' || this.selection.strategy !== previous.strategy)) {
        previous.strategy.releasePreparation?.()
      }
    }
  }

  private async selectNative(
    base: UpdaterStatusWire,
    target: ChannelTarget,
    options: { crossChannel?: boolean; previous?: Selection | null } = {}
  ): Promise<UpdaterStatusWire> {
    if (!options.crossChannel && target.manifest.request.sequence <= this.deps.build.sequence) {
      this.selection = { kind: 'empty' }

      return { ...base, updateAvailable: false }
    }

    // Polling still resolves and validates current metadata, but the identical
    // target can retain its native adapter. Never reuse by version alone: its
    // downloaded/native state belongs to the complete artifact and policy.
    const identity = createHash('sha256')
      .update(JSON.stringify([this.mechanism, Boolean(options.crossChannel), target]))
      .digest('hex')
    const strategy = options.previous?.kind === 'native' && options.previous.identity === identity
      ? options.previous.strategy
      : this.deps.nativeFactory(target)
    try {
      const status = await strategy.check()

      if (status.error || status.updateAvailable === undefined) {
        throw new Error(status.error || 'Native update availability unknown')
      }

      const selectedStatus: UpdaterStatusWire = {
        ...status,
        ...base,
        latestTag: `v${target.manifest.request.version}`,
        targetSha: target.manifest.request.commit
      }
      this.selection = { kind: 'native', identity, strategy, available: status.updateAvailable, status: selectedStatus }

      return selectedStatus
    } catch (error) {
      if (options.previous?.kind !== 'native' || strategy !== options.previous.strategy) {
        strategy.releasePreparation?.()
      }
      throw error
    }
  }

  async prepare(): Promise<boolean> {
    this.enter()

    try {
      if (this.prepared) {
        return true
      }

      // Preparation is an explicit request: admit fresh metadata before pinning.
      await this.select()
      const selected = this.selection
      this.prepared = selected?.kind === 'native' && selected.available
        ? (await selected.strategy.prepare?.()) === true
        : false

      return this.prepared
    } catch (error) {
      this.releasePreparation()
      throw error
    } finally {
      this.busy = false
    }
  }

  releasePreparation(): void {
    const selected = this.selection
    this.prepared = false
    this.selection = null

    if (selected?.kind === 'native') {
      selected.strategy.releasePreparation?.()
    }
  }

  async apply(): Promise<UpdaterApplyResultWire> {
    this.enter()

    try {
      if (!this.selection) {
        await this.select()
      }

      const selected = this.selection

      if (selected?.kind === 'retirement') {
        return { ok: false, error: 'This build is discontinued; uninstall it and install an official release.' }
      }

      if (selected?.kind === 'native' && selected.available) {
        return await selected.strategy.apply()
      }

      return { ok: true, mechanism: this.mechanism }
    } catch (error) {
      this.releasePreparation()
      throw error
    } finally {
      this.prepared = false
      this.busy = false
    }
  }
}
