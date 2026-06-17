import { XMLParser } from 'fast-xml-parser'
import type { AmlItem, AmlResult } from '@shared/ipc'
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
      const text = (value as XmlNode)['#text']
      // Nested relationship Items collapse to a placeholder; full nesting is a later concern.
      properties[key] = text !== undefined ? String(text) : '[item]'
    } else if (Array.isArray(value)) {
      properties[key] = `[${value.length} items]`
    } else {
      properties[key] = String(value)
    }
  }
  return { id, type, properties }
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
  return { raw: xml, items, count: items.length }
}
