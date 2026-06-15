import { describe, it, expect } from 'vitest'
import { isWriteAml, summarizeAml } from './amlIntrospection'

describe('isWriteAml', () => {
  it('treats get queries as read-only', () => {
    expect(isWriteAml('<AML><Item type="Part" action="get" select="id" /></AML>')).toBe(false)
  })

  it.each(['add', 'update', 'edit', 'delete', 'create', 'lock', 'unlock', 'promote', 'recover'])(
    'flags action="%s" as a write',
    (action) => {
      expect(isWriteAml(`<AML><Item type="Part" action="${action}" /></AML>`)).toBe(true)
    }
  )

  it('flags a write even when mixed with gets', () => {
    const aml =
      '<AML><Item type="Part" action="get" /><Item type="Document" action="delete" /></AML>'
    expect(isWriteAml(aml)).toBe(true)
  })
})

describe('summarizeAml', () => {
  it('summarizes actions and types', () => {
    expect(summarizeAml('<AML><Item type="Part" action="update" /></AML>')).toBe('update on Part')
  })
})
