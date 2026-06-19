import type { AmlItem } from '../aras'

/**
 * Method search & caller-discovery primitives, kept free of the connection/AML
 * transport so they can be unit-tested directly and so the *what to look for* is
 * easy to read and extend.
 *
 * Two registries near the bottom are the knobs you'll usually touch:
 *   - METHOD_CALL_PATTERNS — how one Method calls another by name (the regexes).
 *   - CALLER_PROBES        — metadata bindings that reference a Method (AML + parse).
 * Add a pattern or a probe object; nothing else needs to change. They're plain data,
 * not injected dependencies — the orchestrator in tools.ts runs them with its own
 * `readAml`.
 */

// --- snippet extraction (pure) ---------------------------------------------

export interface Snippet {
  /** 1-based line number where this snippet window starts. */
  startLine: number
  lines: string[]
}

export interface SnippetResult {
  snippets: Snippet[]
  /** Total matched lines (may exceed snippets.length once `max` truncates). */
  matchCount: number
  /** True when more than `max` matches existed and the extra snippets were dropped. */
  truncated: boolean
}

/**
 * Pull the lines of `source` that satisfy `matches`, each with `contextLines` of
 * surrounding context. Overlapping/adjacent windows are merged so a cluster of hits
 * reads as one block rather than repeating shared lines. Returns at most `max`
 * snippets and reports whether it truncated.
 */
export function extractSnippets(
  source: string,
  matches: (line: string) => boolean,
  opts: { contextLines: number; max: number }
): SnippetResult {
  const lines = source.split(/\r?\n/)
  const hitRows: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (matches(lines[i])) hitRows.push(i)
  }

  // Build [start,end] windows around each hit, then merge overlaps.
  const windows: Array<[number, number]> = []
  for (const row of hitRows) {
    const start = Math.max(0, row - opts.contextLines)
    const end = Math.min(lines.length - 1, row + opts.contextLines)
    const last = windows[windows.length - 1]
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end)
    } else {
      windows.push([start, end])
    }
  }

  const snippets = windows.slice(0, opts.max).map(([start, end]) => ({
    startLine: start + 1,
    lines: lines.slice(start, end + 1)
  }))

  return {
    snippets,
    matchCount: hitRows.length,
    truncated: windows.length > opts.max
  }
}

// --- SQL LIKE escaping ------------------------------------------------------

/**
 * Escape a user substring for a SQL Server `LIKE` (Aras runs on SQL Server). Bracket
 * escaping works without an ESCAPE clause, so a literal `%`, `_`, or `[` in the
 * pattern can't act as a wildcard. The result is meant to be wrapped in `%...%` and
 * then XML-escaped by the caller before going into AML.
 */
export function likeEscape(s: string): string {
  return s.replace(/[[%_]/g, (c) => `[${c}]`)
}

// --- matcher builders -------------------------------------------------------

/** Case-insensitive literal substring test for a single line. */
export function literalMatcher(literal: string): (line: string) => boolean {
  const needle = literal.toLowerCase()
  return (line) => line.toLowerCase().includes(needle)
}

/** A line matches if it matches ANY of the given regexes. */
export function anyRegexMatcher(regexes: RegExp[]): (line: string) => boolean {
  return (line) => regexes.some((re) => re.test(line))
}

// --- method-to-method call patterns ----------------------------------------

/**
 * How one Method invokes another *by name*. Each entry takes the callee's Method
 * name and returns a regex that recognises a call site for it. Used to filter
 * incidental name mentions (comments, unrelated strings) out of the "methods that
 * call X" layer.
 *
 * To recognise another call convention, add a builder here — e.g. a custom wrapper
 * your codebase uses. `escapeRegex(name)` keeps the name safe inside the pattern.
 */
export const METHOD_CALL_PATTERNS: Array<(name: string) => RegExp> = [
  // this.apply('Name') / inn.applyMethod("Name") / applyMethod('Name')
  (name) => new RegExp(`\\bapply(?:Method)?\\s*\\(\\s*["']${escapeRegex(name)}["']`, 'i'),
  // newItem('Method','...') style construction of a Method call
  (name) => new RegExp(`["']Method["']\\s*,\\s*["']${escapeRegex(name)}["']`, 'i'),
  // AML embedded in source: <Item type="Method" ...><name>Name</name>
  (name) => new RegExp(`<name>\\s*${escapeRegex(name)}\\s*</name>`, 'i'),
  // Bare quoted reference to the method name (loose fallback).
  (name) => new RegExp(`["']${escapeRegex(name)}["']`)
]

/** Build the matcher that decides whether a source line is a call to `name`. */
export function callSiteMatcher(name: string): (line: string) => boolean {
  return anyRegexMatcher(METHOD_CALL_PATTERNS.map((build) => build(name)))
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- metadata caller probes -------------------------------------------------

/** One reference to a Method, surfaced by a {@link CallerProbe}. */
export interface CallerHit {
  /** Free-form fields describing the referencing item (probe decides the shape). */
  [field: string]: string | undefined
}

/**
 * A metadata binding that can reference a Method, expressed as data: the AML to run
 * (given the resolved method) and how to shape the rows into hits. Probes are pure —
 * they neither know about nor hold the AML client. The orchestrator runs each one
 * best-effort and merges the results under `key`.
 *
 * Add a layer by pushing another object to CALLER_PROBES below — no orchestration
 * change needed. `xml`/`xmlAttr` keep interpolated values AML-safe.
 */
export interface CallerProbe {
  /** Machine key for this layer in the tool output, e.g. "actions". */
  key: string
  /** Human description of what this layer finds. */
  label: string
  /** AML query that finds items referencing the given method. */
  buildAml(method: { id: string; name: string }): string
  /** Shape the returned AML items into caller hits. */
  extract(items: AmlItem[]): CallerHit[]
}

export const CALLER_PROBES: CallerProbe[] = [
  {
    key: 'actions',
    label: 'Actions (menu/toolbar/API) bound to this Method',
    buildAml: ({ id }) =>
      `<AML><Item type="Action" action="get" select="name,location">` +
      `<method>${xml(id)}</method></Item></AML>`,
    extract: (items) =>
      items.map((it) => ({ name: it.properties.name, location: it.properties.location }))
  },
  {
    key: 'itemTypeMethods',
    label: 'ItemType server-event bindings that call this Method',
    // "ItemType Method" is the relationship that binds server events (onBeforeAdd, …)
    // to a Method. source_id is the ItemType; the server expands its keyed_name.
    buildAml: ({ id }) =>
      `<AML><Item type="ItemType Method" action="get" select="source_id,name">` +
      `<related_id>${xml(id)}</related_id></Item></AML>`,
    extract: (items) =>
      items.map((it) => ({
        itemType: it.relatedItems?.source_id?.properties.name ?? it.properties['source_id@keyed_name'],
        event: it.properties.name
      }))
  }
]

/** XML-escape a value for an AML element body. */
export function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
