import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quoteWindowsArgument, windowsCommandLine } from '../src/quote.js'
import { parseCommandLine } from './support/command-line-parser.js'

const BS = String.fromCharCode(92)
const TAB = String.fromCharCode(9)
const NL = String.fromCharCode(10)

test('arguments that need no quoting are unchanged', () => {
  assert.equal(quoteWindowsArgument('plain'), 'plain')
  assert.equal(quoteWindowsArgument('C:' + BS + 'tools' + BS + 'node.exe'), 'C:' + BS + 'tools' + BS + 'node.exe')
  assert.equal(quoteWindowsArgument('-NoProfile'), '-NoProfile')
})

test('hand-derived spellings follow the CommandLineToArgvW rules', () => {
  const cases = [
    // Empty arguments must be quoted or they vanish.
    ['', '""'],
    // Whitespace forces quoting.
    ['a b', '"a b"'],
    ['a' + TAB + 'b', '"a' + TAB + 'b"'],
    // A literal quote is escaped with one backslash (2*0+1).
    ['a"b', '"a' + BS + '"b"'],
    // Backslashes not followed by a quote stay literal, and need no quoting by themselves.
    ['a' + BS + 'b', 'a' + BS + 'b'],
    // One backslash before a quote becomes three (2*1+1) so the quote stays literal.
    ['a' + BS + '"b', '"a' + BS + BS + BS + '"b"'],
    // Trailing backslashes double before the closing quote (2*1).
    ['C:' + BS + 'Program Files' + BS, '"C:' + BS + 'Program Files' + BS + BS + '"'],
    // A lone quote inside an otherwise plain argument is still quoted.
    ['"', '"' + BS + '""'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(quoteWindowsArgument(input), expected, JSON.stringify(input))
  }
})

test('every nasty argument survives a round trip through an independent parser', () => {
  const argv = [
    'cmd.exe', '/d', '/c', 'echo', 'a b', '', 'a"b', 'a' + BS + '"b', 'C:' + BS + 'Program Files' + BS,
    'trailing' + BS, 'tab' + TAB + 'here', 'line' + NL + 'break', '"quoted"', 'ünïcode hère', '%PATH%', '&', '|', '^', 'a' + BS + BS + '"',
  ]
  const line = windowsCommandLine(argv)
  assert.deepEqual(parseCommandLine(line), argv)
  assert.equal(line.split(' ').length > argv.length, true, 'the line is a single string, not an argv array')
})

test('an empty argv is refused because MXC requires a non-empty command line', () => {
  assert.throws(() => windowsCommandLine([]), /cannot confine an empty argv/)
})
