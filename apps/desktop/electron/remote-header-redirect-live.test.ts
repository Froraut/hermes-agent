import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build } from 'esbuild'
import { expect, test } from 'vitest'

const displayPrefix = (() => {
  if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return []
  }

  const xvfbRun = (process.env.PATH ?? '')
    .split(delimiter)
    .map(directory => join(directory, 'xvfb-run'))
    .find(existsSync)

  return xvfbRun ? [xvfbRun, '-a'] : null
})()

test.skipIf(displayPrefix === null)(
  'real Electron redirects scope configured gateway headers while preserving same-scope cookies',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-remote-header-redirect-'))

    try {
      const bundle = join(root, 'main.cjs')
      await build({
        entryPoints: [fileURLToPath(new URL('./remote-header-redirect-live-fixture/main.ts', import.meta.url))],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron']
      })
      const env: NodeJS.ProcessEnv = {}

      for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
        if (process.env[name]) {
          env[name] = process.env[name]
        }
      }

      const electron: string = createRequire(import.meta.url)('electron')
      const [command, ...args] = [...(displayPrefix ?? []), electron, bundle, root, '--no-sandbox', '--disable-gpu']
      let stdout = ''

      try {
        stdout = (
          await promisify(execFile)(command, args, {
            env: { ...env, HERMES_HOME: join(root, '.hermes'), XDG_CONFIG_HOME: join(root, 'config') },
            timeout: 45_000
          })
        ).stdout
      } catch (error) {
        const { stderr = '', stdout: partial = '' } = error as { stderr?: string; stdout?: string }
        throw new Error(`Electron fixture failed.\n--- stdout ---\n${partial}\n--- stderr ---\n${stderr}`, {
          cause: error
        })
      }

      expect(stdout).toContain('REMOTE_HEADER_REDIRECT_LIVE_OK')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
