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
