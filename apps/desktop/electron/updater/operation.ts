import type { UpdaterApplyResultWire, UpdaterStrategy } from './index'

/** Preserve one native selection across check/apply and one owner through handoff. */
export class UpdateOperation {
  private strategy: Promise<UpdaterStrategy | null> | undefined
  private applying: boolean = false
  private preparation: Promise<boolean> | undefined
  private preparationOwner: number | undefined

  constructor(private readonly initialize: () => Promise<UpdaterStrategy | null>) {}

  resolve(): Promise<UpdaterStrategy | null> {
    this.strategy ??= this.initialize().catch((error: Error): never => {
      this.strategy = undefined
      throw error
    })

    return this.strategy
  }

  prepare(run: () => Promise<boolean>, owner?: number): Promise<boolean> {
    if (this.applying || (this.preparationOwner !== undefined && this.preparationOwner !== owner)) {
      return Promise.reject(new Error('An update is already in progress.'))
    }

    if (this.preparation) {
      return this.preparation
    }

    this.preparationOwner = owner
    this.preparation = Promise.resolve().then(run).then(
      (prepared: boolean): boolean => {
        if (!prepared) {
          this.preparationOwner = undefined
        }

        return prepared
      },
      (error: unknown): never => {
        this.preparationOwner = undefined
        throw error
      }
    ).finally((): void => {
      this.preparation = undefined
    })

    return this.preparation
  }

  async waitForPreparation(): Promise<void> {
    // The preparation caller reports errors; a later explicit Apply may retry.
    await this.preparation?.catch((): boolean => false)
  }

  async cancelPreparation(owner: number, release: () => void): Promise<void> {
    if (this.applying || this.preparationOwner !== owner) {
      return
    }

    await this.waitForPreparation()

    if (!this.applying && this.preparationOwner === owner) {
      try {
        release()
      } finally {
        this.preparationOwner = undefined
      }
    }
  }

  async apply(run: () => Promise<UpdaterApplyResultWire>, owner?: number): Promise<UpdaterApplyResultWire> {
    if (this.applying || (this.preparationOwner !== undefined && this.preparationOwner !== owner)) {
      throw new Error('An update is already in progress.')
    }

    this.applying = true
    let handedOff: boolean = false

    try {
      await this.waitForPreparation()
      const result: UpdaterApplyResultWire = await run()
      handedOff = result.handedOff === true

      return result
    } finally {
      if (!handedOff) {
        this.applying = false
        this.preparationOwner = undefined
      }
    }
  }
}
