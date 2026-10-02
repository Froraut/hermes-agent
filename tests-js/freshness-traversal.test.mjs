import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildInputs, recordProduct, productCurrent } from '../scripts/build/freshness.mjs'

test('freshness detects same-size edits even when file timestamps are restored', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-freshness-'))
  const source = join(root, 'source')
  const out = join(root, 'out')
  mkdirSync(join(source, 'web/src'), { recursive: true })
  mkdirSync(out)
  const input = join(source, 'web/src/main.ts')
  const output = join(out, 'main.js')
  writeFileSync(input, 'before')
  writeFileSync(output, 'before')
  try {
    const inputs = buildInputs(source, 'web')
    recordProduct({ source, product: 'web', out, inputs })
    expect(productCurrent({ source, product: 'web', out })).toBe(true)
    for (const file of [input, output]) {
      const { atime, mtime } = statSync(file)
      writeFileSync(file, 'after!')
      utimesSync(file, atime, mtime)
      expect(productCurrent({ source, product: 'web', out })).toBe(false)
      writeFileSync(file, 'before')
      expect(productCurrent({ source, product: 'web', out })).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('freshness follows directory junctions and detects removed linked inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-freshness-links-'))
  const source = join(root, 'source')
  const out = join(root, 'out')
  const target = join(root, 'shared')
  mkdirSync(join(source, 'web'), { recursive: true })
  mkdirSync(out)
  mkdirSync(target)
  const file = join(target, 'main.ts')
  writeFileSync(file, 'original')
  try {
    symlinkSync(target, join(source, 'web/src'), process.platform === 'win32' ? 'junction' : 'dir')
    const inputs = buildInputs(source, 'web')
    recordProduct({ source, product: 'web', out, inputs })
    expect(productCurrent({ source, product: 'web', out })).toBe(true)
    writeFileSync(file, 'modified')
    expect(productCurrent({ source, product: 'web', out })).toBe(false)
    writeFileSync(file, 'original')
    expect(productCurrent({ source, product: 'web', out })).toBe(true)
    rmSync(file)
    expect(productCurrent({ source, product: 'web', out })).toBe(false)
    writeFileSync(file, 'original')
    rmSync(join(source, 'web/src'))
    expect(productCurrent({ source, product: 'web', out })).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
