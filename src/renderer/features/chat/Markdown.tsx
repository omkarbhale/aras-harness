import type { ReactNode } from 'react'

/**
 * Dependency-free Markdown renderer for streamed assistant output.
 *
 * Why hand-rolled rather than a library: the bubble re-renders on every streamed
 * token, so partial/unterminated syntax (`**bo`, an unclosed ``` fence) must
 * degrade to literal text and only "snap" into formatting once the closing
 * delimiter arrives — which this parser does for free via non-greedy matching.
 *
 * Safety: every text value lands as a React text child (auto-escaped) and the
 * only HTML attribute we set is a protocol-checked `href`. No
 * `dangerouslySetInnerHTML`, so model output cannot inject markup.
 *
 * Deliberate omission: `_`/`__` are NOT treated as emphasis. This harness deals
 * in Aras identifiers like `item_number` and `created_on`; underscore emphasis
 * would italicise the middle of those. Use `*`/`**` for emphasis instead.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  return <>{renderBlocks(text)}</>
}

const SAFE_URL = /^(https?:|mailto:)/i

// --- Block level -----------------------------------------------------------

function renderBlocks(src: string): ReactNode[] {
  const lines = src.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Blank line — paragraph separator.
    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    // Fenced code block. While streaming, a fence with no closing ``` yet
    // simply consumes to EOF and renders what we have so far.
    const fence = line.match(/^\s*```(.*)$/)
    if (fence) {
      const lang = fence[1]!.trim()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!)
        i++
      }
      i++ // consume the closing fence (harmless past EOF)
      blocks.push(
        <pre className="md-code" key={key++}>
          {lang && <span className="md-code-lang">{lang}</span>}
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    // ATX heading.
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      const Tag = `h${heading[1]!.length}` as keyof JSX.IntrinsicElements
      blocks.push(<Tag key={key++}>{renderInline(heading[2]!)}</Tag>)
      i++
      continue
    }

    // Thematic break: ---, ***, ___ (also spaced: - - -).
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={key++} />)
      i++
      continue
    }

    // Blockquote — gather `>`-prefixed lines, strip one level, recurse.
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(<blockquote key={key++}>{renderBlocks(quote.join('\n'))}</blockquote>)
      continue
    }

    // List (ordered or unordered, with nesting by indentation).
    if (listItem(line)) {
      const [list, consumed] = parseList(lines, i, key++)
      blocks.push(list)
      i = consumed
      continue
    }

    // Paragraph: run of lines until a blank line or the start of another block.
    const para: string[] = []
    while (i < lines.length && !/^\s*$/.test(lines[i]!) && !isBlockStart(lines[i]!)) {
      para.push(lines[i]!)
      i++
    }
    blocks.push(<p key={key++}>{renderInlineLines(para)}</p>)
  }

  return blocks
}

/** True when a line opens a new block, used to terminate a paragraph run. */
function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^\s*#{1,6}\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*_])\s*(\1\s*){2,}$/.test(line) ||
    listItem(line) !== null
  )
}

function listItem(line: string): RegExpMatchArray | null {
  // groups: 1=indent, 2=marker (- * + or "N."), 3=content
  return line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
}

/**
 * Parse one list starting at `lines[start]`. Items at a deeper indent than the
 * first item become a nested list under the preceding item; lines that are
 * indented but not list markers are treated as continuation text. Returns the
 * rendered list and the index of the first line it did not consume.
 */
function parseList(lines: string[], start: number, baseKey: number): [ReactNode, number] {
  const first = listItem(lines[start]!)!
  const indent = first[1]!.length
  const ordered = /\d+\./.test(first[2]!)
  const items: ReactNode[] = []
  let i = start
  let key = 0

  while (i < lines.length) {
    const m = listItem(lines[i]!)
    if (!m || m[1]!.length < indent) break // dedent → list belongs to a parent
    if (m[1]!.length > indent) break // deeper start with no parent item (defensive)

    const content: string[] = [m[3]!]
    i++

    // Pull in nested-list lines and wrapped continuation text for this item.
    const nested: string[] = []
    while (i < lines.length) {
      const deeper = listItem(lines[i]!)
      if (deeper && deeper[1]!.length > indent) {
        nested.push(lines[i]!)
        i++
        continue
      }
      if (!deeper && /^\s+\S/.test(lines[i]!)) {
        content.push(lines[i]!.trim())
        i++
        continue
      }
      break
    }

    const body: ReactNode[] = [...renderInline(content.join(' '))]
    if (nested.length > 0) {
      const [sub] = parseList(nested, 0, 0)
      body.push(sub)
    }
    items.push(<li key={key++}>{body}</li>)
  }

  const list = ordered ? <ol key={baseKey}>{items}</ol> : <ul key={baseKey}>{items}</ul>
  return [list, i]
}

// --- Inline level ----------------------------------------------------------

/** Render paragraph lines, preserving single newlines as `<br>` (GFM-style). */
function renderInlineLines(lines: string[]): ReactNode[] {
  const out: ReactNode[] = []
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`br${idx}`} />)
    out.push(...renderInline(line, `${idx}-`))
  })
  return out
}

type InlineHit = { index: number; length: number; node: (key: string) => ReactNode }

/**
 * Inline emphasis/code/link/strike. Patterns are tried in priority order; the
 * earliest match in the string wins, ties broken by list order (so `**x**`
 * binds as bold before italic). Bold/italic edges require non-space so prose
 * like `2 * 3` does not become emphasis. Code spans are opaque (no nesting).
 */
function renderInline(text: string, kp = ''): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let k = 0

  while (rest.length > 0) {
    const hit = firstInline(rest)
    if (!hit) {
      nodes.push(rest)
      break
    }
    if (hit.index > 0) nodes.push(rest.slice(0, hit.index))
    nodes.push(hit.node(`${kp}${k++}`))
    rest = rest.slice(hit.index + hit.length)
  }

  return nodes
}

function firstInline(s: string): InlineHit | null {
  const candidates: Array<{ re: RegExp; make: (m: RegExpExecArray) => InlineHit['node'] }> = [
    { re: /`([^`]+)`/, make: (m) => (key) => <code className="md-code-inline" key={key}>{m[1]}</code> },
    {
      re: /\[([^\]]*)\]\(([^)\s]+)\)/,
      make: (m) => (key) =>
        SAFE_URL.test(m[2]!) ? (
          <a href={m[2]} target="_blank" rel="noreferrer noopener" key={key}>
            {renderInline(m[1]!, `${key}-`)}
          </a>
        ) : (
          <span key={key}>{m[0]}</span>
        )
    },
    { re: /\*\*(\S[\s\S]*?\S|\S)\*\*/, make: (m) => (key) => <strong key={key}>{renderInline(m[1]!, `${key}-`)}</strong> },
    { re: /~~(\S[\s\S]*?\S|\S)~~/, make: (m) => (key) => <del key={key}>{renderInline(m[1]!, `${key}-`)}</del> },
    { re: /\*(\S[\s\S]*?\S|\S)\*/, make: (m) => (key) => <em key={key}>{renderInline(m[1]!, `${key}-`)}</em> }
  ]

  let best: InlineHit | null = null
  for (const { re, make } of candidates) {
    const m = re.exec(s)
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, length: m[0].length, node: make(m) }
    }
  }
  return best
}
