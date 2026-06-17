import { describe, it, expect } from 'vitest'
import { loadProfiles, passwordEnvKey, resolveCredentials, type ProfileConfig } from './profiles'

const PROFILES: Record<string, ProfileConfig> = {
  dev: { url: 'http://localhost/InnovatorServer', database: 'Dev', username: 'admin' },
  'prod-1': { url: 'https://plm/Server', database: 'Prod', username: 'svc' }
}

describe('passwordEnvKey', () => {
  it('uppercases and sanitizes the profile name', () => {
    expect(passwordEnvKey('dev')).toBe('ARAS_PASSWORD_DEV')
    expect(passwordEnvKey('prod-1')).toBe('ARAS_PASSWORD_PROD_1')
    expect(passwordEnvKey('a.b c')).toBe('ARAS_PASSWORD_A_B_C')
  })
})

describe('loadProfiles', () => {
  it('returns the profiles map from a valid file', () => {
    const out = loadProfiles(
      '/cfg.json',
      () => JSON.stringify({ profiles: PROFILES }),
      () => true
    )
    expect(Object.keys(out)).toEqual(['dev', 'prod-1'])
  })

  it('returns {} when the file is missing', () => {
    expect(loadProfiles('/nope.json', () => '', () => false)).toEqual({})
  })

  it('returns {} when the file is corrupt', () => {
    expect(loadProfiles('/bad.json', () => 'not json', () => true)).toEqual({})
  })
})

describe('resolveCredentials', () => {
  it('uses a saved profile + password env var', () => {
    const creds = resolveCredentials({ profile: 'dev' }, PROFILES, { ARAS_PASSWORD_DEV: 's3cret' })
    expect(creds).toMatchObject({
      instanceUrl: 'http://localhost/InnovatorServer',
      database: 'Dev',
      username: 'admin',
      password: 's3cret',
      name: 'dev'
    })
  })

  it('lets inline fields override the profile', () => {
    const creds = resolveCredentials(
      { profile: 'dev', database: 'Other', password: 'p' },
      PROFILES,
      {}
    )
    expect(creds.database).toBe('Other')
    expect(creds.username).toBe('admin')
  })

  it('uses a password stored inline in the profile', () => {
    const profiles = { dev: { ...PROFILES.dev, password: 'fromfile' } }
    expect(resolveCredentials({ profile: 'dev' }, profiles, {}).password).toBe('fromfile')
  })

  it('password precedence: inline > profile.password > ARAS_PASSWORD_<P> > ARAS_PASSWORD', () => {
    const profiles = { dev: { ...PROFILES.dev, password: 'fromfile' } }
    expect(resolveCredentials({ profile: 'dev', password: 'inline' }, profiles, {}).password).toBe('inline')
    expect(
      resolveCredentials({ profile: 'dev' }, profiles, { ARAS_PASSWORD_DEV: 'env' }).password
    ).toBe('fromfile')
  })

  it('password precedence without a stored profile password: ARAS_PASSWORD_<P> > ARAS_PASSWORD', () => {
    expect(
      resolveCredentials({ profile: 'dev', password: 'inline' }, PROFILES, {
        ARAS_PASSWORD_DEV: 'perprofile',
        ARAS_PASSWORD: 'global'
      }).password
    ).toBe('inline')
    expect(
      resolveCredentials({ profile: 'dev' }, PROFILES, {
        ARAS_PASSWORD_DEV: 'perprofile',
        ARAS_PASSWORD: 'global'
      }).password
    ).toBe('perprofile')
    expect(
      resolveCredentials({ profile: 'dev' }, PROFILES, { ARAS_PASSWORD: 'global' }).password
    ).toBe('global')
  })

  it('falls back to the default env profile when nothing is named', () => {
    const creds = resolveCredentials({}, {}, {
      ARAS_URL: 'http://x/Server',
      ARAS_DATABASE: 'D',
      ARAS_USERNAME: 'u',
      ARAS_PASSWORD: 'p'
    })
    expect(creds).toMatchObject({ instanceUrl: 'http://x/Server', database: 'D', username: 'u', password: 'p' })
    expect(creds.name).toBeUndefined()
  })

  it('takes fully inline credentials with no profile', () => {
    const creds = resolveCredentials(
      { url: 'http://x/Server', database: 'D', username: 'u', password: 'p' },
      {},
      {}
    )
    expect(creds.instanceUrl).toBe('http://x/Server')
  })

  it('throws on an unknown profile name', () => {
    expect(() => resolveCredentials({ profile: 'ghost' }, PROFILES, {})).toThrow(/Unknown profile "ghost"/)
  })

  it('throws listing the missing fields', () => {
    expect(() => resolveCredentials({ url: 'http://x' }, {}, {})).toThrow(/missing: database, username, password/)
  })
})
