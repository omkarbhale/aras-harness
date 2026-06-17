---
name: aras-schema
description: The Aras Innovator metamodel — ItemType, Property, RelationshipType, Method, lifecycle/workflow — and how to discover a live instance's schema with the aras-mcp introspection tools before writing queries.
---

# Aras schema model

Aras is metadata-driven: the schema is itself stored as items you can query. Learn the
target instance's schema before writing AML — never assume property names.

## Core metamodel

- **ItemType** — defines a business object (e.g. `Part`, `Document`, `User`). Rows of
  that type are "items". ItemType definitions are themselves items of type `ItemType`.
- **Property** — a field on an ItemType. Key fields: `name`, `label`, `data_type`
  (string, integer, float, date, item, list, boolean, text…), `data_source` (for
  `item`/`list` types, the referenced type/list).
- **RelationshipType** — a typed link between a *source* ItemType and a *related*
  ItemType (e.g. `Part BOM` links `Part`→`Part`). Relationship rows carry their own
  properties (e.g. `quantity`) plus `source_id` and `related_id`.
- **Method** — server- or client-side code (`method_type`, `method_code`) invokable
  from AML or events.
- **Lifecycle / Workflow** — state machines attached to an ItemType; `promote` moves
  an item between lifecycle states.

## System properties present on most items

`id` (GUID, 32 hex), `config_id`, `keyed_name`, `created_by_id`, `created_on`,
`modified_on`, `state` (current lifecycle state), `is_current`, `generation`,
`major_rev`. Versionable items have generations/revisions.

## Discovery tools (use these first)

| tool | gives you |
|---|---|
| `aras_list_itemtypes` | every ItemType name in the instance |
| `aras_introspect_itemtype` (name) | the ItemType + its Property defs (name/label/data_type) + RelationshipTypes whose source is this type |
| `aras_get_method` (name) | a Method's source code and type |

Typical flow:

```
aras_connect → aras_list_itemtypes → aras_introspect_itemtype "Part"
→ now write AML against the real property names
```

## Reading introspection output

`aras_introspect_itemtype` returns a flat item list mixing the ItemType row, its
Property rows (look at `name` + `data_type`), and RelationshipType rows (`name` +
`related_id`). A property with `data_type=item` points at another ItemType via
`data_source` — follow it with another introspect call when you need the nested shape.

See also: [writing-aml](../writing-aml/SKILL.md).
