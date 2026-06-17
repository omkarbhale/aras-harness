/** Domain DTOs for AML/OData results. Lifted out of the old Electron IPC contract
 *  so the Aras core has no harness dependencies. */

export interface AmlItem {
  id: string
  type: string
  properties: Record<string, string>
  /**
   * Relationship rows returned inside a `<Relationships>` block (e.g. a Part's
   * `Part BOM` rows). Each is itself an AmlItem and may carry its own `relatedItems`
   * (the expanded `related_id`/`source_id` target). Present only when the response
   * actually nested relationships — omitted otherwise.
   */
  relationships?: AmlItem[]
  /**
   * Item-valued properties whose referenced Item was expanded inline by the server
   * (e.g. `related_id`, `source_id`), keyed by property name. `properties[name]` still
   * holds the target's id; this carries the full nested item. Omitted when no property
   * was expanded.
   */
  relatedItems?: Record<string, AmlItem>
}

/** Paging info Aras reports for a `page`/`pagesize` query (absent otherwise). */
export interface AmlPageInfo {
  /** 1-based page number returned. */
  page: number
  /** Total number of pages at the requested page size. */
  pageMax: number
  /** Total number of items matching the query across all pages. */
  itemMax: number
}

export interface AmlResult {
  /** Raw AML/XML response from the server. */
  raw: string
  items: AmlItem[]
  count: number
  /** Present only when the query was paged (`page`/`pagesize`). */
  pageInfo?: AmlPageInfo
}
