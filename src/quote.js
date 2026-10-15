/**
 * Windows command-line assembly for MXC's `process.commandLine`.
 *
 * MXC takes a command line STRING, not an argv array: the harness's exact argv
 * must be quoted back into the single line `CreateProcess` hands the child, so
 * a bare exclamation-free argument never becomes two arguments and a quoted
 * one never becomes a different command. The algorithm is the inverse of the
 * parse performed by `CommandLineToArgvW` and the MSVC CRT:
 *
 * - a backslash run is literal unless it directly precedes a quote;
 * - each quote consumes one backslash pair (`2n` backslashes then a quote
 *   yield `n` backslashes and toggle quoting; `2n+1` yield `n` backslashes
 *   and one literal quote);
 * - an argument is wrapped in quotes when it is empty or contains a space,
 *   tab, newline, vertical tab, or quote.
 *
 * Metacharacters (`&`, `|`, `>`, `^`, `%`) need no escaping: MXC launches the
 * program directly, with no `cmd.exe` in between. A `.cmd` or `.bat` target
 * would need a shell, so this contract only supports executable argv.
 *
 * @module dsh-sandbox-windows-mxc/quote
 */

/** Characters that force an argument to be quoted (the whitespace the CRT treats as a separator). */
const QUOTE_TRIGGERS = /[ \t\n\v"]/u

/**
 * Quote one argv entry for a Windows command line.
 * @param argument - the exact argument the child must receive.
 * @returns the argument's command-line spelling.
 */
export function quoteWindowsArgument(argument) {
  if (argument.length > 0 && !QUOTE_TRIGGERS.test(argument)) return argument
  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    quoted += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * Join an argv into the command line MXC executes.
 * @param argv - the program and its arguments, as the harness supplied them.
 * @returns the command line; throws on an empty argv because MXC requires a
 *   non-empty `process.commandLine`.
 */
export function windowsCommandLine(argv) {
  if (argv.length === 0) throw new Error('dsh-sandbox-windows-mxc: cannot confine an empty argv')
  return argv.map(quoteWindowsArgument).join(' ')
}
