import { describe, it, expect } from 'vitest'
import {
  extractSnippets,
  likeEscape,
  literalMatcher,
  callSiteMatcher,
  CALLER_PROBES
} from './methodSearch'

describe('extractSnippets', () => {
  const src = ['line0', 'hit one', 'line2', 'line3', 'line4', 'hit two', 'line6'].join('\n')

  it('returns matched lines with context and 1-based start line', () => {
    const r = extractSnippets(src, literalMatcher('hit'), { contextLines: 1, max: 10 })
    expect(r.matchCount).toBe(2)
    expect(r.truncated).toBe(false)
    expect(r.snippets[0]).toEqual({ startLine: 1, lines: ['line0', 'hit one', 'line2'] })
    expect(r.snippets[1]).toEqual({ startLine: 5, lines: ['line4', 'hit two', 'line6'] })
  })

  it('merges adjacent/overlapping windows into one block', () => {
    const close = ['a', 'hit', 'hit', 'b'].join('\n')
    const r = extractSnippets(close, literalMatcher('hit'), { contextLines: 1, max: 10 })
    expect(r.matchCount).toBe(2)
    expect(r.snippets).toHaveLength(1)
    expect(r.snippets[0]).toEqual({ startLine: 1, lines: ['a', 'hit', 'hit', 'b'] })
  })

  it('truncates to max snippets and reports it', () => {
    const r = extractSnippets(src, literalMatcher('hit'), { contextLines: 0, max: 1 })
    expect(r.matchCount).toBe(2)
    expect(r.snippets).toHaveLength(1)
    expect(r.truncated).toBe(true)
  })

  it('handles CRLF line endings', () => {
    const r = extractSnippets('a\r\nhit\r\nb', literalMatcher('hit'), { contextLines: 0, max: 10 })
    expect(r.snippets[0]).toEqual({ startLine: 2, lines: ['hit'] })
  })
})

describe('likeEscape', () => {
  it('bracket-escapes SQL LIKE wildcards so they match literally', () => {
    expect(likeEscape('100%')).toBe('100[%]')
    expect(likeEscape('a_b')).toBe('a[_]b')
    expect(likeEscape('arr[0]')).toBe('arr[[]0]')
  })

  it('leaves ordinary text untouched', () => {
    expect(likeEscape('getCost')).toBe('getCost')
  })
})

describe('callSiteMatcher', () => {
  const calls = callSiteMatcher('Part_RecalcCost')

  it('matches apply / applyMethod call conventions', () => {
    expect(calls("this.apply('Part_RecalcCost')")).toBe(true)
    expect(calls('inn.applyMethod("Part_RecalcCost")')).toBe(true)
  })

  it('matches an embedded AML method reference', () => {
    expect(calls('<name>Part_RecalcCost</name>')).toBe(true)
  })

  it('does not match an unrelated comment mentioning the name bareword', () => {
    expect(calls('// see Part_RecalcCost for details')).toBe(false)
  })
})

describe('CALLER_PROBES registry', () => {
  it('every probe builds AML carrying the method id and has key+label', () => {
    for (const probe of CALLER_PROBES) {
      expect(probe.key).toBeTruthy()
      expect(probe.label).toBeTruthy()
      const aml = probe.buildAml({ id: 'M123', name: 'Foo' })
      expect(aml).toContain('M123')
      expect(aml.startsWith('<AML>')).toBe(true)
    }
  })

  it('actions probe extracts name + location', () => {
    const actions = CALLER_PROBES.find((p) => p.key === 'actions')!
    const hits = actions.extract([
      { id: 'a1', type: 'Action', properties: { name: 'Recalc', location: 'toolbar' } }
    ])
    expect(hits).toEqual([{ name: 'Recalc', location: 'toolbar' }])
  })
})
