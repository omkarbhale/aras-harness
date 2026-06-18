import { describe, it, expect } from 'vitest'
import { parseAmlResponse } from './amlParser'
import { ArasFaultError } from './errors'

function soap(body: string): string {
  return (
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`
  )
}

describe('parseAmlResponse — scalar properties', () => {
  it('reads plain string properties', () => {
    const xml = soap(
      '<Result><Item type="Part" id="A"><item_number>P-1</item_number><name>Widget</name></Item></Result>'
    )
    const { items, count } = parseAmlResponse(xml)
    expect(count).toBe(1)
    expect(items[0].properties).toMatchObject({ item_number: 'P-1', name: 'Widget' })
  })

  it('emits "" (not "[item]") for empty is_null properties', () => {
    const xml = soap(
      '<Result><Item type="User" id="U"><login_name>vadmin</login_name>' +
        '<email is_null="1" /><user_no is_null="1" /></Item></Result>'
    )
    const { items } = parseAmlResponse(xml)
    expect(items[0].properties.email).toBe('')
    expect(items[0].properties.user_no).toBe('')
    expect(items[0].properties.login_name).toBe('vadmin')
  })
})

describe('parseAmlResponse — item-reference properties', () => {
  it('keeps the GUID for a text-valued ref and exposes its keyed_name', () => {
    const xml = soap(
      '<Result><Item type="Member" id="M">' +
        '<source_id keyed_name="sg_PowerPlay_Group" type="Identity">5636020293E94E4CBEDBF736D4D4D618</source_id>' +
        '</Item></Result>'
    )
    const { items } = parseAmlResponse(xml)
    expect(items[0].properties.source_id).toBe('5636020293E94E4CBEDBF736D4D4D618')
    expect(items[0].properties['source_id@keyed_name']).toBe('sg_PowerPlay_Group')
  })

  it('resolves an expanded nested-Item ref to the inner id (was "[item]")', () => {
    const xml = soap(
      '<Result><Item type="Member" id="M">' +
        '<related_id keyed_name="Innovator Admin" type="Identity">' +
        '<Item type="Identity" id="DBA5D86402BF43D5976854B8B48FCDD1">' +
        '<name>Innovator Admin</name><is_alias>1</is_alias></Item>' +
        '</related_id></Item></Result>'
    )
    const { items } = parseAmlResponse(xml)
    expect(items[0].properties.related_id).toBe('DBA5D86402BF43D5976854B8B48FCDD1')
    expect(items[0].properties['related_id@keyed_name']).toBe('Innovator Admin')
    // The nested item is NOT hoisted into the top-level result set.
    expect(items).toHaveLength(1)
  })
})

describe('parseAmlResponse — relationships', () => {
  it('returns relationship rows structurally with their expanded related item', () => {
    const xml = soap(
      '<Result><Item type="Part" id="P1"><item_number>MCP-1</item_number>' +
        '<Relationships>' +
        '<Item type="Part BOM" id="R1"><quantity>4</quantity>' +
        '<related_id keyed_name="MCP-2" type="Part">' +
        '<Item type="Part" id="P2"><item_number>MCP-2</item_number><name>Child</name></Item>' +
        '</related_id></Item>' +
        '</Relationships></Item></Result>'
    )
    const { items } = parseAmlResponse(xml)
    // Parent is the only top-level item — relationship/related items are NOT hoisted.
    expect(items).toHaveLength(1)
    const parent = items[0]
    expect(parent.properties.item_number).toBe('MCP-1')

    expect(parent.relationships).toHaveLength(1)
    const bom = parent.relationships![0]
    expect(bom.type).toBe('Part BOM')
    expect(bom.properties.quantity).toBe('4')
    // related_id keeps the id for back-compat...
    expect(bom.properties.related_id).toBe('P2')
    expect(bom.properties['related_id@keyed_name']).toBe('MCP-2')
    // ...and the expanded target is returned in full.
    expect(bom.relatedItems?.related_id?.type).toBe('Part')
    expect(bom.relatedItems?.related_id?.properties).toMatchObject({
      item_number: 'MCP-2',
      name: 'Child'
    })
  })

  it('handles multiple relationship rows', () => {
    const row = (id: string, qty: string) =>
      `<Item type="Part BOM" id="${id}"><quantity>${qty}</quantity></Item>`
    const xml = soap(
      `<Result><Item type="Part" id="P1"><Relationships>${row('R1', '1')}${row('R2', '2')}</Relationships></Item></Result>`
    )
    const { items } = parseAmlResponse(xml)
    expect(items).toHaveLength(1)
    expect(items[0].relationships).toHaveLength(2)
    expect(items[0].relationships!.map((r) => r.properties.quantity)).toEqual(['1', '2'])
  })

  it('omits relationships/relatedItems when the response has none', () => {
    const xml = soap('<Result><Item type="Part" id="P1"><name>x</name></Item></Result>')
    const { items } = parseAmlResponse(xml)
    expect(items[0].relationships).toBeUndefined()
    expect(items[0].relatedItems).toBeUndefined()
  })
})

describe('parseAmlResponse — paging', () => {
  it('extracts page/pageMax/itemMax from a paged response', () => {
    const item = (id: string) =>
      `<Item type="Identity" id="${id}" page="2" pagemax="17" itemmax="51"><name>${id}</name></Item>`
    const xml = soap(
      `<Result>${item('A')}${item('B')}</Result>` +
        '<Message><event name="pagemax" value="17" /><event name="itemmax" value="51" />' +
        '<event name="items_with_no_access_count" value="0" /></Message>'
    )
    const { pageInfo, count } = parseAmlResponse(xml)
    expect(count).toBe(2)
    expect(pageInfo).toEqual({ page: 2, pageMax: 17, itemMax: 51 })
  })

  it('omits pageInfo for a non-paged response', () => {
    const xml = soap('<Result><Item type="Part" id="A"><name>x</name></Item></Result>')
    expect(parseAmlResponse(xml).pageInfo).toBeUndefined()
  })
})

describe('parseAmlResponse — faults', () => {
  it('normalizes "No items found" to an empty result', () => {
    const xml = soap(
      '<SOAP-ENV:Fault><faultcode>0</faultcode>' +
        '<faultstring>No items of type Part found.</faultstring></SOAP-ENV:Fault>'
    )
    expect(parseAmlResponse(xml)).toMatchObject({ count: 0, items: [] })
  })

  it('throws ArasFaultError on a real fault', () => {
    const xml = soap(
      '<SOAP-ENV:Fault><faultcode>0</faultcode>' +
        '<faultstring>No permission to access this item</faultstring></SOAP-ENV:Fault>'
    )
    expect(() => parseAmlResponse(xml)).toThrow(ArasFaultError)
  })
})
