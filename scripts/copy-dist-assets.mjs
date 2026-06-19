// Copy the runtime resources the server needs at runtime into dist/ so a shipped
// build is self-contained: `dist/server.js` resolves scripts/native relative to
// itself (see findResourceRoot in src/mcp/packaging.ts) instead of reaching back
// into the source tree. Runs after `tsup --clean` has rebuilt dist/.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

mkdirSync(join(dist, 'scripts'), { recursive: true })
for (const f of ['import.ps1', 'export.ps1']) {
  cpSync(join(root, 'scripts', f), join(dist, 'scripts', f))
}
cpSync(join(root, 'native'), join(dist, 'native'), { recursive: true })
cpSync(join(root, 'skills'), join(dist, 'skills'), { recursive: true })

console.log('Copied scripts/, native/, skills/ into dist/')
