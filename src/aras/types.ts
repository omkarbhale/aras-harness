/** Domain DTOs for AML/OData results. Lifted out of the old Electron IPC contract
 *  so the Aras core has no harness dependencies. */

export interface AmlItem {
  id: string
  type: string
  properties: Record<string, string>
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
