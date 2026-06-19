import { defineConfig } from 'tsup'

// Bundle the npm dependencies INTO dist/server.js (noExternal) so the build is truly
// self-contained: `node dist/server.js` runs with no node_modules alongside it. Node
// builtins (node:*) stay external — they're provided by the runtime. Paired with the
// scripts/native/skills copy in scripts/copy-dist-assets.mjs, dist/ is fully portable.
export default defineConfig({
  entry: ['src/mcp/server.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // Bundle everything that isn't a node builtin.
  noExternal: [/.*/]
})
