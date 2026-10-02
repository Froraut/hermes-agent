import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import * as preparation from '../apps/desktop/scripts/prepare-packaging-tools.mjs'
import { publishPackagingInputs } from '../apps/desktop/scripts/prepared-packaging.mjs'

function fixture(root, target = `${process.platform}-x64`, formats = ['dir', 'zip']) {
  const source = path.join(root, 'source')
  const out = path.join(root, 'prepared')
  const write = (file, bytes = 'good') => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
    return file
  }
  const packages = {}
  for (const name of ['app-builder-lib', 'electron-builder']) {
    const directory = path.join(source, 'node_modules', name)
    write(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    write(path.join(directory, 'index.js'), 'module.exports = {}')
    packages[`node_modules/${name}`] = { version: '1.0.0' }
  }
  for (const file of ['util/electronGet.js', 'toolsets/7zip.js', 'toolsets/icons.js']) {
    write(path.join(source, 'node_modules/app-builder-lib/dist', file), "throw new Error('unexpected supplier acquisition')")
  }
  write(path.join(source, 'package-lock.json'), JSON.stringify({ packages }))
  write(path.join(source, 'apps/desktop/package.json'), '{}')
  write(path.join(source, 'apps/desktop/electron-builder.config.cjs'), 'module.exports = {}')
  const electron = write(path.join(out, 'electron.zip'))
  const toolsets = { sevenZip: path.join(out, 'sevenZip'), icons: path.join(out, 'icons') }
  for (const directory of Object.values(toolsets)) write(path.join(directory, 'tool'))
  let windows = null
  if (target.startsWith('win32-')) {
    const kit = path.join(out, 'winCodeSign')
    const dotnetRoot = path.join(out, 'dotnet')
    toolsets.winCodeSign = kit
    windows = { makeappx: write(path.join(kit, 'makeappx.exe')), signtool: write(path.join(kit, 'signtool.exe')),
      dlib: write(path.join(kit, 'Azure.CodeSigning.Dlib.dll')), dotnetRoot }
    write(path.join(dotnetRoot, 'dotnet.exe'))
  }
  const dmgbuild = formats.includes('dmg') ? write(path.join(out, 'dmgbuild/dmgbuild')) : null
  if (dmgbuild) write(path.join(out, 'dmgbuild/python/bin/python3'))
  return { source, out, target, formats, electron, toolsets, windows, windowsSigning: true, dmgbuild, write }
}

test('source preparation retains admitted suppliers across UI builds and rehashes unchanged-size bytes before reuse', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-supplier-reuse-'))
  try {
    const f = fixture(root)
    const manifest = await publishPackagingInputs(f)
    const receipt = fs.readFileSync(manifest, 'utf8')
    const prepare = () => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../apps/desktop/scripts/prepare-packaging-tools.mjs'),
      '--source', f.source, '--out', f.out, '--cache', path.join(root, 'cache'), '--target', f.target,
      '--format', 'zip', '--format', 'dir'], { encoding: 'utf8', env: { ...process.env, CUSTOM_DMGBUILD_PATH: '' }, timeout: 5000 })
    const first = prepare()
    assert.equal(first.status, 0, first.stderr)
    assert.equal(first.stdout.trim(), manifest)
    f.write(path.join(f.source, 'apps/desktop/src/ui.ts'), 'new product source')
    const second = prepare()
    assert.equal(second.status, 0, second.stderr)
    assert.equal(fs.readFileSync(manifest, 'utf8'), receipt)
    const tool = path.join(f.toolsets.icons, 'tool')
    const stat = fs.statSync(tool)
    fs.writeFileSync(tool, 'evil')
    fs.utimesSync(tool, stat.atime, stat.mtime)
    const damaged = prepare()
    assert.notEqual(damaged.status, 0)
    assert.match(damaged.stderr, /unexpected supplier acquisition/)
    assert.equal(fs.existsSync(manifest), false)
    fs.writeFileSync(tool, 'good')
    f.write(path.join(f.source, 'apps/desktop/electron-builder.config.cjs'), "module.exports = { toolsets: { icons: { url: 'file://mutable-icons' } } }")
    await publishPackagingInputs(f)
    const custom = prepare()
    assert.notEqual(custom.status, 0)
    assert.match(custom.stderr, /unexpected supplier acquisition/)
    assert.equal(fs.existsSync(manifest), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('supplier reuse preserves target, format, pin and signing selections and compares explicit complete dmgbuild vendors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-supplier-selection-'))
  try {
    const f = fixture(root, 'darwin-x64', ['dmg', 'zip'])
    const manifest = await publishPackagingInputs(f)
    const supplied = f.write(path.join(root, 'selected-dmgbuild/dmgbuild'))
    const pairedPython = f.write(path.join(root, 'selected-dmgbuild/python/bin/python3'))
    const reuse = options => preparation.reusePackagingInputs({ source: f.source, out: f.out, target: f.target,
      formats: ['zip', 'dmg'], dmgbuild: supplied, ...options })
    assert.equal(reuse({}), manifest)
    assert.equal(reuse({ target: 'darwin-arm64' }), null)
    assert.equal(reuse({ formats: ['zip'] }), null)
    assert.equal(reuse({ windowsSigning: false }), null)
    const stat = fs.statSync(pairedPython)
    fs.writeFileSync(pairedPython, 'evil')
    fs.utimesSync(pairedPython, stat.atime, stat.mtime)
    assert.equal(reuse({}), null)
    fs.rmSync(pairedPython)
    assert.throws(() => reuse({}), /paired Python is missing/)
    f.write(pairedPython)
    const lock = path.join(f.source, 'package-lock.json')
    fs.writeFileSync(lock, JSON.stringify({ packages: { changed: { version: '2.0.0' } } }))
    assert.equal(reuse({}), null)
    for (const format of ['AppImage', 'deb']) {
      const incomplete = fixture(path.join(root, format), 'linux-x64', [format])
      await publishPackagingInputs(incomplete)
      assert.equal(preparation.reusePackagingInputs(incomplete), null)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
