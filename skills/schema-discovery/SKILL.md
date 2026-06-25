---
name: schema-discovery
description: Working brief for a subagent doing Aras schema discovery — find the relevant ItemTypes/properties/relationships for a task and return only that slice, keeping the parent agent's context lean.
---

# Schema discovery (subagent brief)

You are a subagent spawned to discover the slice of an Aras instance's schema that a
task needs, and return **only that slice** — not raw dumps. The parent agent wants
the conclusion, not the exploration.

## Preconditions

- The `aras_*` tools are already available to you.
- A connection is **already active** (it is shared per server process). Do **not**
  call `aras_connect` — assume you are connected. If a call reports no connection,
  say so and stop; do not try to authenticate.

## Flow

1. `aras_list_itemtypes` — get all ItemType names.
2. Pick candidates by the task's intent (e.g. "BOM cost" → `Part`, `Part BOM`,
   relevant relationships). Don't introspect everything.
3. `aras_introspect_itemtype` on each candidate — properties (name, label, data_type)
   and RelationshipTypes whose source is that ItemType.
4. Optional: `aras_search_methods` if the task touches server/client logic, or
   `aras_get_method` for one specific method body.

See the `aras-schema` skill (via aras_skill) for the metamodel if you need it.

## Return

Return a concise summary: the ItemTypes, the specific properties, and the
relationships that matter for the task — with exact `name`s the parent can put
straight into AML. Omit irrelevant properties and unrelated ItemTypes. If you
truncated or skipped anything, say so. Do not paste full introspection output.
