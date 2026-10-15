import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patchText = readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8')
const patch = parseYaml(patchText)

/**
 * Whether a `files` entry covers a shipped path, honoring the three forms the
 * manifest uses: a literal path, a recursive JavaScript subtree, and a
 * single-directory JSON glob.
 * @param pattern - one `files` entry.
 * @param file - a workspace-relative shipped path.
 */
function matchesPattern(pattern, file) {
  if (pattern.endsWith('/**/*.js')) return file.startsWith(pattern.slice(0, -'**/*.js'.length)) && file.endsWith('.js')
  if (pattern.endsWith('/*.json')) {
    const prefix = pattern.slice(0, -'*.json'.length)
    return file.startsWith(prefix) && file.slice(prefix.length).endsWith('.json')
  }
  return false
}

/** Every runtime file the bundle ships, as the installer would read them. */
const RUNTIME_EXPORTS = ['.', './runner', './icon']
const LOCALES = ['locale/en.json', 'locale/zh.json']

test('the manifest declares a bundle whose patch exists', () => {
  assert.equal(manifest.name, 'dsh-sandbox-windows-mxc')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, manifest.dsh.bundle.patch)))
  assert.equal(manifest.private, undefined, 'the plugin is publishable')
})

test('every runtime export and asset is listed in the manifest and on disk', () => {
  for (const specifier of [...RUNTIME_EXPORTS, './locale/*.json', './package.json']) {
    assert.ok(specifier in manifest.exports, specifier + ' is not exported')
  }
  const files = [...manifest.files, 'package.json']
  const shipped = [
    'index.js', 'runner.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh.md',
    ...LOCALES,
    'src/argv.js', 'src/classify.js', 'src/config.js', 'src/locate.js', 'src/paths.js', 'src/policy.js', 'src/quote.js',
  ]
  for (const file of shipped) {
    assert.ok(existsSync(join(root, file)), file + ' is missing from disk')
    const covered = files.includes(file) || files.some(pattern => matchesPattern(pattern, file))
    assert.ok(covered, file + ' is not covered by the manifest files list')
  }
})

test('the patch disables the shipped Windows rung and inserts this plugin', () => {
  const override = patch.find(entry => entry.id === 'sandbox')
  assert.ok(override !== undefined, 'the shipped sandbox row is not overridden')
  assert.equal(override.insert, undefined)
  assert.match(String(override.disabled), /process\.platform === 'win32'/)
  const inserted = patch.flatMap(entry => entry.insert ?? []).find(row => row.id === 'sandbox-mxc')
  assert.ok(inserted !== undefined, 'the sandbox-mxc row is not inserted')
  assert.equal(inserted.name, manifest.name)
  assert.match(String(inserted.disabled), /process\.platform !== 'win32'/)
})

test('display metadata is real copy in every locale, with no template text left', () => {
  for (const file of LOCALES) {
    const locale = JSON.parse(readFileSync(join(root, file), 'utf8'))
    assert.equal(typeof locale.meta.title, 'string')
    assert.equal(typeof locale.meta.description, 'string')
    assert.ok(locale.meta.title.length >= 4 && locale.meta.title.length <= 60, file + ' title length')
    assert.ok(locale.meta.description.length >= 40, file + ' description is too short to describe the capability')
    assert.ok(!/my-decoration|lorem|example/i.test(locale.meta.title + locale.meta.description), file + ' keeps template copy')
  }
  const zh = JSON.parse(readFileSync(join(root, 'locale/zh.json'), 'utf8'))
  assert.match(zh.meta.description, /[\u4e00-\u9fff]/u, 'the zh locale is not translated')
})

test('the icon is a valid, self-contained SVG inside the size budget', () => {
  const icon = readFileSync(join(root, 'icon.svg'), 'utf8')
  assert.ok(statSync(join(root, 'icon.svg')).size <= 256 * 1024)
  assert.match(icon.trimStart(), /^<svg[\s>]/u)
  assert.ok(icon.trimEnd().endsWith('</svg>'))
  assert.match(icon, /viewBox="0 0 64 64"/)
  assert.ok(!/xlink:href="(?!#)|<image|url\(https?:/u.test(icon), 'the icon must not reference external resources')
  assert.equal(manifest.icon, './icon.svg')
  assert.equal(manifest.exports['./icon'], './icon.svg')
})
