/**
 * In-process test aggregate. Node's test runner spawns one child per file;
 * this harness imports every suite into one process instead, so the suites run
 * even where the host refuses new child processes. Pass an argument to select
 * files by substring (`node tests/run.js spawn`).
 */

import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]
const names = (await readdir(here))
  .filter(name => name.endsWith('.test.js'))
  .filter(name => filter === undefined || name.includes(filter))
  .sort()

if (names.length === 0) {
  process.stderr.write('no test files match ' + JSON.stringify(filter) + '\n')
  process.exitCode = 1
} else {
  for (const name of names) {
    process.stdout.write('# ' + name + '\n')
    await import(pathToFileURL(join(here, name)).href)
  }
}
