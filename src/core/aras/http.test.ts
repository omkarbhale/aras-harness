import { describe, it, expect } from 'vitest'
import { withRetry, isRetryableError } from './http'
import { ArasFaultError, ArasAuthError, ArasRequestError } from './errors'

describe('isRetryableError', () => {
  it('does not retry deterministic failures', () => {
    expect(isRetryableError(new ArasFaultError('bad query'))).toBe(false)
    expect(isRetryableError(new ArasAuthError('token rejected'))).toBe(false)
    expect(isRetryableError(new ArasRequestError('bad request', 400))).toBe(false)
    expect(isRetryableError(new ArasRequestError('not found', 404))).toBe(false)
  })

  it('retries transient failures', () => {
    expect(isRetryableError(new ArasRequestError('server error', 500))).toBe(true)
    expect(isRetryableError(new ArasRequestError('bad gateway', 502))).toBe(true)
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true)
  })
})

describe('withRetry', () => {
  it('throws non-retryable errors immediately without burning attempts', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new ArasFaultError('Failed to get the ZZZ ItemType.')
    }
    await expect(withRetry(fn, undefined, { baseDelayMs: 1 })).rejects.toMatchObject({
      name: 'ArasFaultError',
      message: 'Failed to get the ZZZ ItemType.'
    })
    expect(calls).toBe(1) // failed fast — did not retry a deterministic fault.
  })

  it('retries transient errors up to maxAttempts then surfaces the real error', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new ArasRequestError('temporary', 503)
    }
    await expect(
      withRetry(fn, undefined, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toMatchObject({ name: 'ArasRequestError', status: 503 })
    expect(calls).toBe(3)
  })

  it('returns the result once fn succeeds', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 2) throw new ArasRequestError('temporary', 500)
      return 'ok'
    }
    const result = await withRetry(fn, undefined, { baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })
})
