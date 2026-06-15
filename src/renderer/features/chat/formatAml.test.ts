import { describe, it, expect } from 'vitest'
import { formatAml } from './formatAml'

describe('formatAml', () => {
  it('indents nested elements', () => {
    const out = formatAml('<AML><Item type="Part" action="get"><name>1</name></Item></AML>')
    expect(out).toBe(
      ['<AML>', '  <Item type="Part" action="get">', '    <name>1</name>', '  </Item>', '</AML>'].join(
        '\n'
      )
    )
  })

  it('keeps self-closing tags on their own line without increasing depth', () => {
    const out = formatAml('<AML><Item type="Part" action="get" select="id" /></AML>')
    expect(out).toBe(['<AML>', '  <Item type="Part" action="get" select="id" />', '</AML>'].join('\n'))
  })

  it('collapses text-only elements onto one line', () => {
    expect(formatAml('<name>Bracket</name>')).toBe('<name>Bracket</name>')
  })

  it('returns non-XML input unchanged', () => {
    expect(formatAml('not xml')).toBe('not xml')
  })
})
