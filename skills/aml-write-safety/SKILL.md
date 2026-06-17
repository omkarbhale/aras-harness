---
name: aml-write-safety
description: Safe practice for mutating an Aras instance through aras_run_write — which actions mutate, why writes are never retried, how to scope updates/deletes so they can't hit every row, and verify-before-and-after discipline. Use before any add/update/delete/promote/lock AML.
---

# AML write safety

`aras_run_write` changes live data. Treat it like running SQL against production.

## What counts as a write

These actions mutate and must go through `aras_run_write` (the read tool refuses them):

`add`, `create`, `update`, `edit`, `delete`, `purge`, `copy`, `merge`, `lock`,
`unlock`, `promote`, `recover`.

Everything else (`get`) is a read for `aras_run_query`.

## Rules

1. **Scope precisely.** An `update`/`delete` without an `id` or a tight filter can
   affect *every* item of that type. Prefer `id="..."`. If using `where`, first run the
   identical predicate as a `get` and confirm the row count is what you expect.

2. **Writes are never retried.** Unlike reads, `aras_run_write` runs the AML exactly
   once. A network error after the server committed would otherwise double-apply. If a
   write errors, **verify state with a `get` before re-issuing** — don't blindly retry.

3. **Read before you write.** `aras_introspect_itemtype` to confirm property names and
   data types; a misspelled property is silently ignored on some configs.

4. **Verify after.** Follow a write with a `get` on the same `id` to confirm the change
   landed as intended.

5. **The host gates the call.** `aras_run_write` is marked destructive, so the MCP host
   (Claude Code / OpenCode / etc.) prompts the user for approval before it runs. Make the
   AML and your intent legible so that approval is an informed one — one item, one clear
   change per call where possible.

6. **Prefer reversible actions.** `delete` (versionable) over `purge` (hard) unless a
   hard delete is explicitly required. Be aware `promote` triggers lifecycle side-effects
   (workflows, methods on state change).

## Pattern: targeted update

```xml
<!-- 1. read to get the id + current value (aras_run_query) -->
<AML><Item type="Part" action="get" select="id,name" maxRecords="2"><item_number>P-1000</item_number></Item></AML>

<!-- 2. update by id (aras_run_write) -->
<AML><Item type="Part" action="update" id="THE_ID_FROM_STEP_1"><name>Updated</name></Item></AML>

<!-- 3. verify (aras_run_query) -->
<AML><Item type="Part" action="get" select="name" id="THE_ID_FROM_STEP_1"/></AML>
```

See also: [writing-aml](../writing-aml/SKILL.md).
