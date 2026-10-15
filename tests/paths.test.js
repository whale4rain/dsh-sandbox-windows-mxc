import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertTempRootOutsideWorkspace, canonicalPath, isSameOrInside } from '../src/paths.js'

const BS = String.fromCharCode(92)

test('containment is case-insensitive and separator-aware', () => {
  const root = join('C:', 'ws')
  assert.equal(isSameOrInside(root, root), true)
  assert.equal(isSameOrInside(root, join('C:', 'ws', 'sub', 'file.txt')), true)
  assert.equal(isSameOrInside(root, join('C:', 'WS', 'SUB')), true)
  // A sibling whose name merely starts with the root's name is not inside it.
  assert.equal(isSameOrInside(root, join('C:', 'ws-other')), false)
  assert.equal(isSameOrInside(root, join('C:', 'elsewhere')), false)
})

test('a temp root inside the workspace is refused in both directions', () => {
  const root = join('C:', 'ws')
  assert.throws(() => assertTempRootOutsideWorkspace(root, root), /must not be the workspace or inside it/)
  assert.throws(() => assertTempRootOutsideWorkspace(root, join('C:', 'ws', 'tmp')), /must not be the workspace or inside it/)
  // The ambient temp root is outside the workspace: no throw.
  assertTempRootOutsideWorkspace(root, tmpdir())
})

test('canonicalization resolves junctions and fails soft on missing paths', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mxc-paths-'))
  try {
    const real = join(base, 'real')
    mkdirSync(real)
    writeFileSync(join(real, 'marker.txt'), 'x')
    const link = join(base, 'link')
    try {
      symlinkSync(real, link, 'junction')
      assert.equal(canonicalPath(link), canonicalPath(real))
      assert.equal(isSameOrInside(link, join(real, 'marker.txt')), true)
    } catch {
      // Junction creation needs no privilege on NTFS; skip only if the volume refuses it.
    }
    const missing = join(base, 'does-not-exist')
    assert.equal(canonicalPath(missing), missing)
    assert.equal(isSameOrInside(missing, join(missing, 'x')), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
