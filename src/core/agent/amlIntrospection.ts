/** AML actions that create, change, or remove data and therefore require approval. */
const WRITE_ACTIONS = new Set([
  'add',
  'create',
  'update',
  'edit',
  'delete',
  'copy',
  'purge',
  'merge'
])

/**
 * Heuristic: does this AML body contain a mutating action? Used to gate writes behind
 * a human approval. Conservative by construction — only explicit write `action="..."`
 * attributes trigger the gate (server-method calls are not flagged in the MVP).
 */
export function isWriteAml(aml: string): boolean {
  for (const match of aml.matchAll(/\baction\s*=\s*"([^"]*)"/gi)) {
    if (WRITE_ACTIONS.has(match[1].trim().toLowerCase())) return true
  }
  return false
}

/** Short human-readable summary of what an AML body will do, for the approval prompt. */
export function summarizeAml(aml: string): string {
  const actions = new Set<string>()
  const types = new Set<string>()
  for (const m of aml.matchAll(/\baction\s*=\s*"([^"]*)"/gi)) actions.add(m[1].trim().toLowerCase())
  for (const m of aml.matchAll(/\btype\s*=\s*"([^"]*)"/gi)) types.add(m[1].trim())
  const actionStr = [...actions].join(', ') || 'unknown'
  const typeStr = [...types].join(', ') || 'unknown'
  return `${actionStr} on ${typeStr}`
}
