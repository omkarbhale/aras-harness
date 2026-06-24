import { describe, it, expect } from 'vitest'
import { loadSkills, readSkillBody, parseFrontmatter, findSkillsDir } from './skills'

describe('skills', () => {
  it('finds the bundled skills dir', () => {
    expect(findSkillsDir()).toBeTruthy()
  })

  it('loads all four skills with name + description', () => {
    const skills = loadSkills()
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['aml-write-safety', 'aras-schema', 'odata-queries', 'writing-aml'])
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(10)
    }
  })

  it('reads a skill body including its heading', () => {
    const body = readSkillBody('writing-aml')
    expect(body).toContain('# Writing AML')
  })

  it('returns undefined for an unknown skill', () => {
    expect(readSkillBody('does-not-exist')).toBeUndefined()
  })

  it('parses frontmatter name + description', () => {
    const fm = parseFrontmatter('---\nname: foo\ndescription: bar baz\n---\n# Body')
    expect(fm).toEqual({ name: 'foo', description: 'bar baz' })
  })
})
