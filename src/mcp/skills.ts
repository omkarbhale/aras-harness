import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Agent-facing usage guidance shipped as markdown under `skills/`. These are exposed
 * over MCP two ways: as resources (uri `aras-skill://<name>`) and via the `aras_skill`
 * tool. Only the short `description` of each costs context until something fetches the
 * body, so the agent can pull the right guidance on demand.
 */
export interface Skill {
  name: string
  description: string
  /** Absolute path to the SKILL.md backing this skill. */
  path: string
}

/** URI scheme used for skill resources. */
export const SKILL_URI_PREFIX = 'aras-skill://'

/**
 * Locate the bundled `skills/` directory. Mirrors packaging.findResourceRoot: the build
 * copies `skills/` next to `server.js`, so walk up from this module until we find a dir
 * whose `skills/` actually holds a known skill. Works from `dist/server.js` (shipped) and
 * from `src/mcp/skills.ts` (tsx/vitest run from the package root). Returns undefined if
 * nothing is bundled, so callers degrade to "no skills" rather than crashing.
 */
export function findSkillsDir(startDir = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, 'skills')
    if (existsSync(join(cand, 'writing-aml', 'SKILL.md'))) return cand
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Pull `name:` / `description:` out of a SKILL.md YAML frontmatter block. */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const block = m[1]
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim()
  return { name, description }
}

let cache: Skill[] | undefined

/** Discover and parse all bundled skills (cached for the process lifetime). */
export function loadSkills(): Skill[] {
  if (cache) return cache
  const dir = findSkillsDir()
  if (!dir) return (cache = [])
  const skills: Skill[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(path)) continue
    const { name, description } = parseFrontmatter(readFileSync(path, 'utf8'))
    skills.push({ name: name ?? entry.name, description: description ?? '', path })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return (cache = skills)
}

/** Read the full markdown (incl. frontmatter) for one skill, or undefined if unknown. */
export function readSkillBody(name: string): string | undefined {
  const skill = loadSkills().find((s) => s.name === name)
  return skill ? readFileSync(skill.path, 'utf8') : undefined
}
