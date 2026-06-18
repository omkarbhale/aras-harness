---
name: odata-queries
description: Querying Aras Innovator over its OData v4 REST endpoint with aras_run_odata — URL/path shape, $select/$filter/$top/$orderby/$expand options, and when to prefer OData over AML. Use when composing OData query strings for the aras-mcp server.
---

# OData queries

Aras exposes a read-only OData v4 service at `/server/odata`. The `aras_run_odata` tool
takes just the path + query string that follows `/server/odata/` — do not include the
base URL.

```
Part?$top=10&$select=item_number,name&$orderby=item_number
```

## Common system query options

| option | example | effect |
|---|---|---|
| `$select` | `$select=item_number,name` | limit returned properties (always use it) |
| `$filter` | `$filter=item_number eq 'P-1000'` | row predicate |
| `$top` / `$skip` | `$top=25&$skip=50` | paging |
| `$orderby` | `$orderby=created_on desc` | sort |
| `$count` | `$count=true` | include total count |
| `$expand` | `$expand=Part BOM` | inline a relationship |

## Filter operators

`eq ne gt ge lt le`, `and or not`, and functions like `contains(name,'pump')`,
`startswith(item_number,'P-')`, `endswith(...)`. Strings use single quotes; escape an
embedded quote by doubling it (`'O''Brien'`).

```
Part?$filter=startswith(item_number,'P-') and is_current eq true&$select=item_number,name&$top=50
```

## OData vs AML — which to use

- **OData** is best for straightforward reads: filtering, sorting, paging, light expand.
  Cleaner JSON, easy `$filter`.
- **AML** (`aras_run_query`) is best for Aras-specific semantics: deep relationship
  graphs, server-side item behaviors, and anything you'll mirror as a write.
- **Writes** are AML-only here — there is no OData write tool. Use `aras_run_write`.

## Notes

- The entity set name is the ItemType name (URL-encode spaces, e.g. `Part%20BOM`).
- Results are truncated to keep responses small; narrow with `$select`/`$top` rather
  than fetching everything.
- Auth/token handling is automatic once `aras_connect` has run.

See also: [writing-aml](../writing-aml/SKILL.md), [aras-schema](../aras-schema/SKILL.md).
