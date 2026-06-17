import { XMLParser } from 'fast-xml-parser'
import type { AmlItem, AmlPageInfo, AmlResult } from './types'
import { ArasFaultError } from './errors'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep text content under a predictable key.
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true
})

type XmlNode = Record<string, unknown>

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Depth-first search for the first node whose key matches one of `names`. */
function findFirst(node: unknown, names: string[]): XmlNode | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const obj = node as XmlNode
  for (const key of Object.keys(obj)) {
    const localName = key.includes(':') ? key.split(':')[1] : key
    if (names.includes(localName)) {
      const value = obj[key]
      return (Array.isArray(value) ? value[0] : value) as XmlNode
    }
  }
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    const nested = Array.isArray(value)
      ? value.map((v) => findFirst(v, names)).find(Boolean)
      : findFirst(value, names)
    if (nested) return nested
  }
  return undefined
}

/** Collect every `<Item>` node anywhere in the tree. */
function collectItems(node: unknown, out: XmlNode[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) collectItems(v, out)
    return
  }
  const obj = node as XmlNode
  for (const key of Object.keys(obj)) {
    const localName = key.includes(':') ? key.split(':')[1] : key
    if (localName === 'Item') {
      for (const item of asArray(obj[key])) out.push(item as XmlNode)
    } else {
      collectItems(obj[key], out)
    }
  }
}

function attrKeyedName(o: XmlNode | undefined): string | undefined {
  const k = o?.['@_keyed_name']
  return k === undefined ? undefined : String(k)
}

/**
 * Resolve an item-valued property element to `{ id, keyedName }`.
 *
 * Aras serializes item references three ways, all of which used to collapse to the
 * literal `"[item]"` (hiding the real value):
 *   - text-valued ref:  `<source_id keyed_name="X" type="..">GUID</source_id>`
 *   - expanded ref:     `<related_id keyed_name="X"><Item id="GUID">..</Item></related_id>`
 *   - empty value:      `<email is_null="1" />`  (or a plain empty element)
 */
function resolveItemValue(value: XmlNode): { id: string; keyedName?: string } {
  if (value['#text'] !== undefined) {
    return { id: String(value['#text']), keyedName: attrKeyedName(value) }
  }
  const nested = value['Item']
  if (nested !== undefined) {
    const inner = (Array.isArray(nested) ? nested[0] : nested) as XmlNode | undefined
    return { id: String(inner?.['@_id'] ?? ''), keyedName: attrKeyedName(value) ?? attrKeyedName(inner) }
  }
  // Empty element (e.g. is_null="1") — genuinely no value, NOT a placeholder.
  return { id: '' }
}

function toItem(node: XmlNode): AmlItem {
  const id = String(node['@_id'] ?? '')
  const type = String(node['@_type'] ?? '')
  const properties: Record<string, string> = {}
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_') || key === '#text') continue
    const value = node[key]
    if (value === null || value === undefined) {
      properties[key] = ''
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const { id: refId, keyedName } = resolveItemValue(value as XmlNode)
      properties[key] = refId
      // Carry the human-readable label alongside the id when Aras provides one and it
      // adds information (the id itself is opaque GUID).
      if (keyedName !== undefined && keyedName !== '' && keyedName !== refId) {
        properties[`${key}@keyed_name`] = keyedName
      }
    } else if (Array.isArray(value)) {
      properties[key] = `[${value.length} items]`
    } else {
      properties[key] = String(value)
    }
  }
  return { id, type, properties }
}

/**
 * Extract paging info from a paged response. Aras reports it twice: as
 * `<Message><event name="pagemax" .../></Message>` (sibling of `<Result>`) and as
 * `page`/`pagemax`/`itemmax` attributes on each result Item. We prefer the events
 * (single source) and fall back to item attributes; the current page number only
 * lives on the items. Returns undefined for non-paged queries.
 */
function extractPageInfo(tree: XmlNode, itemNodes: XmlNode[]): AmlPageInfo | undefined {
  let pageMax: number | undefined
  let itemMax: number | undefined

  const message = findFirst(tree, ['Message'])
  if (message) {
    for (const ev of asArray(message['event'])) {
      const e = ev as XmlNode
      const name = e['@_name']
      if (name === 'pagemax') pageMax = Number(e['@_value'])
      else if (name === 'itemmax') itemMax = Number(e['@_value'])
    }
  }

  const first = itemNodes[0]
  if (pageMax === undefined && first?.['@_pagemax'] !== undefined) pageMax = Number(first['@_pagemax'])
  if (itemMax === undefined && first?.['@_itemmax'] !== undefined) itemMax = Number(first['@_itemmax'])
  if (pageMax === undefined || itemMax === undefined || Number.isNaN(pageMax) || Number.isNaN(itemMax)) {
    return undefined
  }

  const page = first?.['@_page'] !== undefined ? Number(first['@_page']) : 1
  return { page: Number.isNaN(page) ? 1 : page, pageMax, itemMax }
}

/**
 * Parse an Aras SOAP/AML response. Throws {@link ArasFaultError} on a SOAP Fault,
 * otherwise returns the flattened list of items.
 */
export function parseAmlResponse(xml: string): AmlResult {
  const tree = parser.parse(xml) as XmlNode

  const fault = findFirst(tree, ['Fault'])
  if (fault) {
    const faultString =
      (fault['faultstring'] as string | undefined) ??
      ((fault['detail'] as XmlNode | undefined)?.['message'] as string | undefined) ??
      'Aras server fault'
    const faultCode = fault['faultcode'] as string | undefined
    // Aras reports "query matched nothing" as a fault: faultcode 0 + "No items of type X found".
    // That's a normal empty result, NOT an error — surface it as zero items so callers don't
    // mistake it for a failure (and retry it to death). Match the faultstring specifically:
    // faultcode 0 alone is reused for other soft faults (e.g. "No permission to access this item").
    if (/^No items of type .+ found/i.test(String(faultString).trim())) {
      return { raw: xml, items: [], count: 0 }
    }
    throw new ArasFaultError(String(faultString), faultCode ? String(faultCode) : undefined)
  }

  const itemNodes: XmlNode[] = []
  collectItems(tree, itemNodes)
  const items = itemNodes.map(toItem)
  const pageInfo = extractPageInfo(tree, itemNodes)
  return { raw: xml, items, count: items.length, ...(pageInfo ? { pageInfo } : {}) }
}
