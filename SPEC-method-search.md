# Spec: Method search & caller discovery

Status: proposed
Author: (drafted with Claude Code)
Scope: two new read-only MCP tools for working with Aras `Method` items without
pulling whole method bodies into the agent's context.

## 1. Problem

Today the only way an agent works with server-side Methods is:

- `aras_get_method(name)` — returns the **entire** `method_code`.
- `aras_run_query` with AML — searching `method_code` (e.g. `condition="like"`)
  returns the **entire** body of every match.
- `aras_run_write` — to change a Method you re-send the **entire** replaced body.

Two consequences:

1. **Discovery blows up context.** "Which methods touch `Part.cost`?" pulls back
   N full method bodies. A handful of hits can be tens of thousands of tokens, most
   of it irrelevant to the question being asked.
2. **No relationship view.** "What calls this Method / what breaks if I change it?"
   has no answer at all — method-to-method calls and the metadata that binds methods
   to ItemType events, Actions, and lifecycle transitions are invisible. This is the
   thing an agent genuinely cannot reconstruct cheaply, and it is exactly what a
   filesystem `grep` has no equivalent for.

The fix is **not** to clone the whole file-tool suite. Methods are usually small
(dozens to low-hundreds of lines), so whole-read is rarely the pain, and there is no
filesystem — every write is a full property replace under the hood, so a surgical
`Edit` tool buys token economy, not atomicity. The high-leverage gap is **discovery**.

## 2. Scope

**Build now:**

- `aras_search_methods` — pattern search over `method_code` that returns **matched
  snippets, never full bodies**.
- `aras_find_method_callers` — relationship-aware "who references this Method",
  spanning method-to-method calls plus the metadata bindings (Actions, ItemType
  server events).

**Explicitly deferred** (see §8): a surgical `Edit`-style method writer, and
partial/offset reads of a single method.

Both new tools are **read-only** (AML `action="get"` only) and carry no
`destructiveHint`.

## 3. AML capabilities & the server/host split

What the database can do for us:

- `method_code` is a text/CLOB property. AML supports a SQL `LIKE` pre-filter:
  ```xml
  <AML><Item type="Method" action="get" select="name,method_type">
    <method_code condition="like">%cost%</method_code>
  </Item></AML>
  ```
- AML cannot do regex, word boundaries, or return a **snippet** — only whole property
  values.

So the strategy is **narrow on the server, refine on the host**:

1. Push a **literal substring** to the DB via `LIKE` to get a small candidate set
   (names + ids, *without* selecting `method_code`).
2. Fetch `method_code` only for candidates, then do snippet extraction (and optional
   regex refine) **host-side**, returning only matched lines ± context.

This bounds cost: the expensive `method_code` payload is fetched only for rows the
literal pre-filter already matched, and never returned wholesale to the agent.

## 4. Tool: `aras_search_methods`

### Input (zod)

```ts
{
  pattern: z.string()
    .describe('Literal substring to find in method source (SQL LIKE pre-filter, ' +
              'case-insensitive). Required — it bounds how many bodies are fetched.'),
  regex: z.string().optional()
    .describe('Optional regex to refine matches host-side, applied only to methods ' +
              'the literal pattern already matched. Use for word boundaries / alternation.'),
  nameLike: z.string().optional()
    .describe('Restrict to Methods whose name matches this LIKE pattern.'),
  methodType: z.enum(['server', 'client', 'any']).optional().default('any')
    .describe('Filter by method_type (C#/VB/SQL server vs JavaScript client).'),
  contextLines: z.number().int().min(0).max(5).optional().default(1)
    .describe('Lines of context to include around each matched line.'),
  maxMethods: z.number().int().min(1).max(200).optional().default(50)
    .describe('Cap on candidate methods fetched (protects context + the server).'),
  maxSnippetsPerMethod: z.number().int().min(1).max(20).optional().default(5)
}
```

### Behaviour

1. Build the candidate query: `Method action="get" select="name,method_type"` with
   `<method_code condition="like">%pattern%</method_code>`, plus `nameLike` /
   `methodType` conditions when given. Do **not** select `method_code` here.
2. If the candidate count exceeds `maxMethods`, take the first `maxMethods` and flag
   `truncated: true` (never silently drop — surface what was capped).
3. Fetch `method_code` for the candidate ids (batched).
4. Host-side, for each method: find matching lines (literal `pattern`, case-insensitive;
   if `regex` given, the line must also match the regex). Emit up to
   `maxSnippetsPerMethod` snippets, each with `± contextLines`.
5. Return structured JSON (no full bodies).

### Output

```jsonc
{
  "pattern": "cost",
  "regex": null,
  "truncated": false,
  "candidateCount": 7,
  "returnedCount": 7,
  "methods": [
    {
      "id": "ABC123...",
      "name": "Part_RecalcCost",
      "methodType": "server",
      "matchCount": 3,
      "snippets": [
        { "startLine": 41, "lines": ["  // recalc cost", "  item.cost = sum;"] }
      ],
      "snippetsTruncated": false
    }
  ]
}
```

When zero candidates: `ok` with `"methods": []` and a one-line note, not an error.

## 5. Tool: `aras_find_method_callers`

Answers "what references this Method / what might break if I change it", layered by
confidence. Phase 1 covers the three highest-value, cheapest layers; deeper bindings
(workflows, full lifecycle maps) are phase 2.

### Input

```ts
{
  name: z.string().describe('Exact Method name to find references to.'),
  includeSource: z.boolean().optional().default(false)
    .describe('If true, include the calling snippet for method-to-method references.')
}
```

### Behaviour — phase 1 layers

1. **Method → Method calls.** Reuse the §4 search engine with `pattern = name`
   over all `method_code`. Aras method-to-method calls surface as the method name in
   source (`this.apply('Name')`, `Innovator.applyMethod('Name')`,
   `<method>Name</method>`, etc.), so a literal search for the name catches them.
   Return caller name + (optional) snippet.
2. **Action bindings.** Query `Action` items whose `method` property points at this
   Method's id (`Action action="get" select="name,location"` with the method id).
   These are the toolbar/menu/API actions that invoke it.
3. **ItemType server events.** Query the ItemType↔Method bindings (server events such
   as `onBeforeAdd`, `onAfterUpdate`) that reference this Method id.

Each layer is **best-effort and independent** (one attempt, failures degrade to an
empty layer with a `warnings[]` note) — mirroring how `aras_introspect_itemtype`
already treats its RelationshipType lookup.

### Output

```jsonc
{
  "method": { "id": "ABC123...", "name": "Part_RecalcCost" },
  "found": true,
  "callers": {
    "methods":   [ { "id": "...", "name": "Part_OnUpdate", "snippets": [ ... ] } ],
    "actions":   [ { "id": "...", "name": "Recalc", "location": "..." } ],
    "itemTypeEvents": [ { "itemType": "Part", "event": "onAfterUpdate" } ]
  },
  "warnings": []
}
```

`found: false` (not an error) when the named Method doesn't exist.

## 6. Edge cases & limits

- **Cost cap is mandatory.** `maxMethods` exists so a 1-char `pattern` can't fetch the
  whole method store. Truncation is always reported, never silent (project convention —
  see the "no silent caps" rule used elsewhere).
- **Binary / huge methods.** If a candidate body exceeds a size ceiling, skip snippet
  extraction for it and list it under a `skipped[]` array with its size, rather than
  ballooning the response.
- **LIKE special chars.** Escape `%` and `_` in the user `pattern` before building the
  AML condition so a literal `%` doesn't become a wildcard.
- **Case.** LIKE is case-insensitive on most Aras DBs; host-side literal match is
  forced case-insensitive to stay consistent. Document this.
- **method_type values.** Confirm the actual stored values (`server`/`client` is the
  conceptual split; map from the real `method_type` strings during implementation).

## 7. Testing

- **Unit** (mirror `tools.test.ts`, mocked AML handler):
  - candidate query selects name/type but **not** `method_code`.
  - snippet extraction returns only matched lines ± context, respects
    `maxSnippetsPerMethod`.
  - `truncated` set when candidates exceed `maxMethods`.
  - LIKE wildcard escaping.
  - regex refine narrows a literal-matched set.
  - `find_method_callers` merges the three layers; a failing layer degrades to empty +
    warning rather than failing the whole call.
- **Live** (gated on `ARAS_TEST_*`, like `live.test.ts`): search a known stock Method
  substring against a real instance, assert snippets returned and no full body present
  in the payload. Read-only, safe against any instance.

## 8. Non-goals / deferred

Deferred until a real harness demonstrably hits the wall — methods are small enough
that these may never be the bottleneck:

- **`aras_edit_method` (surgical write).** A read-modify-write that takes
  `{ name, oldString, newString }`, applies the replace host-side, and writes the full
  body back. Only benefit over `aras_run_write` is token economy + fewer accidental
  clobbers; under the hood it's still a full property replace, so no atomicity gain.
  **Revisit when** observed harness runs choke on re-emitting large bodies or produce
  clobbering errors.
- **Partial / offset read of one method.** Low leverage given typical method size.
  **Revisit when** a real method is large enough that whole-read is the bottleneck.

## 9. Rollout

1. Implement `aras_search_methods` (the snippet engine is the reusable core).
2. Implement `aras_find_method_callers` on top of that engine + the metadata queries.
3. Register both in `src/mcp/server.ts` (read tools, no `destructiveHint`); document in
   `README.md` tool table and add a short note to the `aras-schema` skill on using
   search before `aras_get_method`.
