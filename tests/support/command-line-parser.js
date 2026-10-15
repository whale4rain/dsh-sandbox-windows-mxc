/**
 * A command-line parser written from the documented Windows rules, used as the
 * independent counterpart to the plugin's quoting: MXC takes a command line, so
 * the only proof that a wrapped argv survives the trip is reading the line back.
 *
 * Rules (CommandLineToArgvW / MSVC CRT):
 * - arguments are separated by unquoted space, tab, newline, or vertical tab;
 * - a backslash run not followed by a quote is literal;
 * - `2n` backslashes followed by a quote produce n backslashes and toggle
 *   quoting; `2n+1` produce n backslashes and one literal quote.
 *
 * @param line - the command line to parse.
 * @returns the argument vector the child's runtime would see.
 */
export function parseCommandLine(line) {
  const isSeparator = character => character === ' ' || character === '\t' || character === '\n' || character === '\v'
  const arguments_ = []
  let index = 0
  while (index < line.length) {
    while (index < line.length && isSeparator(line[index])) index += 1
    if (index >= line.length) break
    let argument = ''
    let quoted = false
    while (index < line.length && (quoted || !isSeparator(line[index]))) {
      const character = line[index]
      if (character === '\\') {
        let backslashes = 0
        while (index < line.length && line[index] === '\\') {
          backslashes += 1
          index += 1
        }
        if (index < line.length && line[index] === '"') {
          argument += '\\'.repeat(Math.floor(backslashes / 2))
          if (backslashes % 2 === 1) {
            argument += '"'
          } else {
            quoted = !quoted
          }
          index += 1
        } else {
          argument += '\\'.repeat(backslashes)
        }
        continue
      }
      if (character === '"') {
        quoted = !quoted
        index += 1
        continue
      }
      argument += character
      index += 1
    }
    arguments_.push(argument)
  }
  return arguments_
}
