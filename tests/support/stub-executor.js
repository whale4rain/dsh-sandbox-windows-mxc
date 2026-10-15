/**
 * Stand-in for `wxc-exec.exe` in the runner's spawn tests: it records the
 * request the runner wrote, echoes configured output, and exits with a
 * configured status, so the runner's relay, mirroring, and failure
 * classification can be observed without MXC or Windows containment.
 *
 * Environment:
 * - `STUB_REPORT`: path to write the JSON observation report to.
 * - `STUB_STDOUT` / `STUB_STDERR`: text to echo on each stream.
 * - `STUB_EXIT`: exit status to report (default 0).
 */

import { readFileSync, writeFileSync } from 'node:fs'

const configPath = process.argv[process.argv.length - 1]
const report = {
  argv: process.argv.slice(1),
  configPath,
  request: JSON.parse(readFileSync(configPath, 'utf8')),
  cwd: process.cwd(),
  environment: {
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    CONTROL: process.env.DSH_SUBPROCESS_CONTROL,
  },
}
if (process.env.STUB_REPORT !== undefined) writeFileSync(process.env.STUB_REPORT, JSON.stringify(report, null, 2), 'utf8')
if (process.env.STUB_STDOUT !== undefined) process.stdout.write(process.env.STUB_STDOUT)
if (process.env.STUB_STDERR !== undefined) process.stderr.write(process.env.STUB_STDERR)
process.exitCode = Number(process.env.STUB_EXIT ?? '0')
