import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { prepareWindowsPackaging } from '../apps/desktop/scripts/prepare-packaging-tools.mjs'
import { publishPackagingInputs, readPackagingInputs } from '../apps/desktop/scripts/prepared-packaging.mjs'
import { runElectronBuilder, validatePreparedBuilderArgs } from '../apps/desktop/scripts/run-electron-builder.mjs'
import { ensureWindowsBundleTools } from '../apps/desktop/scripts/windows-bundle-tools.mjs'

const signingKeys = ['AZURE_SIGN_ENDPOINT', 'AZURE_CLIENT_ID', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE']
function unsignedEnvironment() {
  const previous = Object.fromEntries(signingKeys.map(key => [key, process.env[key]]))
  for (const key of signingKeys) delete process.env[key]
  return () => {
    for (const key of signingKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function fixture(root) {
  const source = path.join(root, 'source')
  const out = path.join(root, 'prepared')
  const write = (file, bytes = 'supplier fixture') => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    return file
  }
  write(path.join(source, 'package-lock.json'), '{}')
  write(path.join(source, 'apps/desktop/package.json'), '{}')
  write(path.join(source, 'apps/desktop/electron-builder.config.cjs'), 'module.exports = {}')
  const kit = path.join(root, 'vendor/sdk/x64')
  const ats = path.join(root, 'vendor/ats')
  const dotnet = path.join(root, 'vendor/dotnet')
  write(path.join(kit, 'makeappx.exe'))
  write(path.join(kit, 'signtool.exe'))
  write(path.join(ats, 'x64/Azure.CodeSigning.Dlib.dll'))
  write(path.join(dotnet, 'dotnet.exe'))
  const rcedit = { x64: write(path.join(root, 'vendor/rcedit-x64.exe')), x86: write(path.join(root, 'vendor/rcedit-x86.exe')) }
  const acquisitions = []
  const builder = {
    WIN_CODESIGN_LATEST: 'fixture',
    getWindowsKitsBundle: async () => { acquisitions.push('sdk'); return { kit } },
    getRceditBundle: async () => { acquisitions.push('rcedit'); return rcedit },
    getAtsBundleDir: async () => { acquisitions.push('ats'); return ats },
    getDotnetRuntimeDir: async () => { acquisitions.push('dotnet'); return dotnet },
  }
  const electron = write(path.join(out, 'electron.zip'))
  const toolsets = { sevenZip: path.join(out, 'sevenZip'), icons: path.join(out, 'icons') }
  for (const directory of Object.values(toolsets)) write(path.join(directory, 'tool'))
  return { source, out, electron, toolsets, builder, acquisitions }
}

test('unsigned directory preparation retains resource tools and integrity while rejecting signing and release consumption', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-source-packaging-'))
  const restoreEnvironment = unsignedEnvironment()
  try {
    const f = fixture(root)
    const { kitRoot, windows } = await prepareWindowsPackaging({ out: f.out, config: {}, resourcesDir: root, builder: f.builder, signing: false })
    assert.deepEqual(f.acquisitions, ['sdk', 'rcedit'])
    assert.equal(fs.existsSync(path.join(f.out, 'dotnet')), false)
    assert.equal(windows.dlib, null)
    assert.equal(windows.dotnetRoot, null)
    for (const file of [windows.makeappx, windows.signtool, path.join(kitRoot, 'rcedit-x64.exe'), path.join(kitRoot, 'rcedit-x86.exe')]) assert.equal(fs.statSync(file).isFile(), true)
    const inputs = { ...f, target: 'win32-x64', formats: ['dir'], windows, windowsSigning: false,
      toolsets: { ...f.toolsets, winCodeSign: kitRoot } }
    const manifest = await publishPackagingInputs(inputs)
    const consume = signing => ensureWindowsBundleTools({ prepared: manifest, source: f.source, target: inputs.target, signing, config: {},
      load: async () => { throw new Error('prepared consumption must not acquire tools') } })
    assert.equal((await consume(false)).makeappx, windows.makeappx)
    await assert.rejects(consume(true), /Missing prepared Windows signing tools/)
    const prepared = readPackagingInputs(manifest, f.source, inputs.target)
    assert.throws(() => validatePreparedBuilderArgs(['--win', 'msix'], prepared), /not prepared/)
    await assert.rejects(publishPackagingInputs({ ...inputs, formats: ['msix'] }), /restricted to source directory/)
    fs.writeFileSync(path.join(kitRoot, 'rcedit-x64.exe'), 'changed bytes')
    await assert.rejects(consume(false), /changed packaging input/)
  } finally {
    restoreEnvironment()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release preparation stays complete without credentials and both signing consumers retain complete source inputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-signing-capability-'))
  const restoreEnvironment = unsignedEnvironment()
  try {
    const f = fixture(root)
    const { windows } = await prepareWindowsPackaging({ out: f.out, config: {}, resourcesDir: root, builder: f.builder })
    assert.ok(f.acquisitions.includes('ats') && f.acquisitions.includes('dotnet'))
    assert.equal(fs.statSync(windows.dlib).isFile(), true)
    assert.equal(fs.statSync(path.join(windows.dotnetRoot, 'dotnet.exe')).isFile(), true)
    for (const [args, env, unsigned] of [
      [['--win', '--dir'], {}, true],
      [['--win', 'msix'], {}, false],
      [['--win', '--dir'], { AZURE_SIGN_ENDPOINT: 'test', AZURE_CLIENT_ID: 'test' }, false],
      [['--win', '--dir'], { AZURE_SIGN_ENDPOINT: 'test', AZURE_SIGN_ACCOUNT: 'test', AZURE_SIGN_PROFILE: 'test' }, false],
    ]) {
      for (const key of signingKeys) delete process.env[key]
      Object.assign(process.env, env)
      const calls = []
      assert.equal(runElectronBuilder(args, { spawn: (_node, command) => { calls.push(command); return { status: 0 } } }), 0)
      const prepare = calls.find(command => command[0].endsWith('prepare-packaging-tools.mjs'))
      assert.equal(prepare.includes('--unsigned-dir'), unsigned)
      if (!unsigned && args.includes('--dir')) {
        assert.throws(() => validatePreparedBuilderArgs(args, { windowsSigning: false, formats: ['dir'], target: 'win32-x64' }), /signing was enabled/)
      }
    }
  } finally {
    restoreEnvironment()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
