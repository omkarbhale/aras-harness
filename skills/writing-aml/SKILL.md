---
name: writing-aml
description: How to write correct AML (Aras Markup Language) for the aras-mcp tools — document structure, the get/add/update/delete actions, select, where/idlist filtering, maxRecords, and relationships. Use whenever composing AML to pass to aras_run_query or aras_run_write.
---

# Writing AML

AML is Aras Innovator's XML query/command language. Every call to `aras_run_query`
(reads) or `aras_run_write` (mutations) takes one complete AML document.

## Document shape

Always wrap items in a single `<AML>` root:

```xml
<AML>
  <Item type="Part" action="get" select="id,item_number,name" maxRecords="25"/>
</AML>
```

- `type` — the ItemType name, exact and case-sensitive (e.g. `Part`, `Document`). Use
  `aras_list_itemtypes` / `aras_introspect_itemtype` to confirm names and properties.
- `action` — what to do (see below).
- `select` — comma-separated property list. **Always set `select`** to keep responses
  small and predictable; omit only when you truly need every property.
- `maxRecords` — cap rows on reads. Set it on exploratory queries.

## Actions

| action | tool | meaning |
|---|---|---|
| `get` | `aras_run_query` | read items |
| `add` / `create` | `aras_run_write` | insert a new item |
| `update` / `edit` | `aras_run_write` | modify an existing item (needs `id` or a where-clause) |
| `delete` / `purge` | `aras_run_write` | remove (delete = versionable soft path; purge = hard) |
| `promote` | `aras_run_write` | change lifecycle state |
| `lock` / `unlock` | `aras_run_write` | edit-lock control |

Reads go to `aras_run_query`; anything mutating goes to `aras_run_write`. The query
tool rejects mutating AML, and the write tool rejects non-mutating AML.

## Filtering

Three common ways to scope a `get`:

1. **Property criteria** — child elements equal to a value:
   ```xml
   <Item type="Part" action="get" select="item_number,name">
     <classification>Component</classification>
   </Item>
   ```
2. **`where` attribute** — raw SQL-ish predicate against the DB columns:
   ```xml
   <Item type="Part" action="get" select="item_number" where="[Part].item_number LIKE 'P-1%'"/>
   ```
3. **`id` / `idlist`** — fetch by key(s):
   ```xml
   <Item type="Part" action="get" id="ABC123..." select="item_number"/>
   ```

Other useful attributes: `orderBy="name"`, `page`/`pagesize`, `levels` (relationship depth).

## Updates and deletes — always target precisely

Mutations without an `id` or filter can hit **every** row. Prefer `id`:

```xml
<AML>
  <Item type="Part" action="update" id="ABC123...">
    <name>New name</name>
  </Item>
</AML>
```

## Relationships

Relationships are items too. To add a related item inline:

```xml
<AML>
  <Item type="Part" action="add">
    <item_number>P-1000</item_number>
    <Relationships>
      <Item type="Part BOM" action="add">
        <quantity>2</quantity>
        <related_id>
          <Item type="Part" action="get"><item_number>P-2000</item_number></Item>
        </related_id>
      </Item>
    </Relationships>
  </Item>
</AML>
```

Use `aras_introspect_itemtype` to discover which RelationshipTypes an ItemType has.

## Workflow

1. `aras_connect` first.
2. `aras_introspect_itemtype` to learn properties + relationships before writing AML.
3. Draft a `get` with `select` + `maxRecords`, run via `aras_run_query`.
4. For changes, target by `id`, run via `aras_run_write` (the host will gate it).

See also: [aras-schema](../aras-schema/SKILL.md), [aml-write-safety](../aml-write-safety/SKILL.md).
