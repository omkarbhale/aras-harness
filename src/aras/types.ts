/** Domain DTOs for AML/OData results. Lifted out of the old Electron IPC contract
 *  so the Aras core has no harness dependencies. */

export interface AmlItem {
  id: string
  type: string
  properties: Record<string, string>
}

export interface AmlResult {
  /** Raw AML/XML response from the server. */
  raw: string
  items: AmlItem[]
  count: number
}
