/**
 * Pretty-print an AML / XML string with 2-space indentation so it reads as a
 * document rather than a one-line blob. Elements whose only content is text stay
 * on a single line (e.g. `<name>Bracket</name>`). Best-effort and total: returns
 * the trimmed input unchanged if it doesn't look like XML or can't be tokenized.
 */
export function formatAml(xml: string): string {
  const input = xml.trim()
  if (!input.startsWith('<')) return input

  // Tokens are either a tag (<...>) or the text run between two tags.
  const tokens = input.match(/<[^>]+>|[^<]+/g)
  if (!tokens) return input

  const unit = '  '
  const pad = (depth: number): string => unit.repeat(Math.max(0, depth))
  const lines: string[] = []
  let depth = 0

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].trim()
    if (tok === '') continue

    if (!tok.startsWith('<')) {
      // Stray text not captured by the inline rule below.
      lines.push(pad(depth) + tok)
      continue
    }

    const isClose = tok.startsWith('</')
    const isSelfClose = tok.endsWith('/>')
    const isDecl = tok.startsWith('<?') || tok.startsWith('<!')

    if (isClose) {
      depth -= 1
      lines.push(pad(depth) + tok)
    } else if (isSelfClose || isDecl) {
      lines.push(pad(depth) + tok)
    } else {
      // Opening tag. Collapse `<tag>text</tag>` onto one line.
      const next = tokens[i + 1]?.trim() ?? ''
      const after = tokens[i + 2]?.trim() ?? ''
      if (next !== '' && !next.startsWith('<') && after.startsWith('</')) {
        lines.push(pad(depth) + tok + next + after)
        i += 2
      } else {
        lines.push(pad(depth) + tok)
        depth += 1
      }
    }
  }

  return lines.join('\n')
}
