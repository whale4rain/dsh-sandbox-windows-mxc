/**
 * Piped-stdio fixture: the pattern the harness's Windows ACL backend documents as
 * impossible (". . . confined grandchildren fail with EPERM because libuv's pipe
 * stdio uses named pipes whose client-end open requests write access no
 * restricting SID is granted").
 *
 * Run INSIDE the sandbox. Each case prints one JSON line; the process exits
 * non-zero if any of them fails, so a backend that reintroduces the EPERM
 * shows up as a failing acceptance case rather than as a mysterious tool error
 * in a session.
 *
 * CommonJS on purpose: the repository is an ESM package, and this file has to be
 * runnable by a bare `node <path>` inside the container.
 */

const { spawnSync } = require('node:child_process')
const net = require('node:net')

const results = []
const record = (label, ok, detail) => results.push({ label, ok, detail })

/** Case 1: inherited stdio (no pipe objects involved). */
const inherited = spawnSync(process.execPath, ['-e', 'console.log("child-inherit")'], { stdio: 'inherit' })
record('inherit', inherited.status === 0, { status: inherited.status })

/** Case 2: piped stdio — libuv creates and opens a named pipe for each stream. */
const piped = spawnSync(process.execPath, ['-e', 'console.log("child-pipe")'], { encoding: 'utf8' })
record('node-pipe', piped.status === 0 && String(piped.stdout).includes('child-pipe'), {
  status: piped.status,
  errorCode: piped.error && piped.error.code,
  stdout: String(piped.stdout ?? '').trim(),
})

/** Case 3: a system executable over pipes, the control for "is it the pipe or the image". */
const systemPiped = spawnSync('cmd', ['/c', 'echo cmd-pipe'], { encoding: 'utf8' })
record('cmd-pipe', systemPiped.status === 0 && String(systemPiped.stdout).includes('cmd-pipe'), {
  status: systemPiped.status,
  errorCode: systemPiped.error && systemPiped.error.code,
})

/** Case 4: a named pipe this confined process creates and opens itself. */
const pipeName = String.raw`\\.\pipe\dsh-mxc-piped-stdio-` + process.pid
const server = net.createServer((socket) => socket.end('pong'))
let settled = false
/** Record case 4 once, whichever event arrives first. */
const settle = (ok, detail) => {
  if (settled) return
  settled = true
  record('named-pipe', ok, detail)
  server.close()
  finish()
}
server.on('error', error => settle(false, { serverError: error.code }))
server.listen(pipeName, () => {
  const client = net.connect(pipeName, () => client.write('ping'))
  let received = ''
  client.on('data', (chunk) => { received += chunk })
  client.on('close', () => settle(received === 'pong', { received }))
  client.on('error', error => settle(false, { clientError: error.code }))
})

/** Print the report and exit with the verdict. */
function finish() {
  let failed = 0
  for (const result of results) {
    if (!result.ok) failed += 1
    console.log(JSON.stringify(result))
  }
  process.exit(failed === 0 ? 0 : 1)
}
