/**
 * Tests for the report cache.
 *
 * It had none. A review's mutation table showed that removing expiry, removing eviction, and
 * ignoring the per-result TTL callback entirely all left the suite green — on a module whose whole
 * job is bounding GA4 fan-out against a property with a ten-concurrent ceiling, and which had just
 * been changed to cache failures briefly.
 *
 * Timers are faked rather than slept on, so expiry is asserted at the boundary instead of
 * approximately and the suite stays fast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TTL_MS, cacheKey, clearCache, getCached, setCached, withCache } from './cache'

describe('cacheKey', () => {
	beforeEach(() => { clearCache() })

	it('separates keys that differ in any part', () => {
		expect(cacheKey(['vi', 'darden', 'overview'])).not.toBe(cacheKey(['vi', 'darden', 'journey']))
	})

	it('treats an absent part as empty rather than as the string "undefined"', () => {
		expect(cacheKey(['vi', undefined])).toBe('vi|')
	})

	it('does not collide across a part boundary', () => {
		// Without a separator, ['a','bc'] and ['ab','c'] would be the same key and two different
		// sites could read each other's reports.
		expect(cacheKey(['a', 'bc'])).not.toBe(cacheKey(['ab', 'c']))
	})
})

describe('expiry', () => {
	beforeEach(() => { clearCache(); vi.useFakeTimers() })
	afterEach(() => { vi.useRealTimers() })

	it('serves a value inside its TTL', () => {
		setCached('k', 'value', 1000)
		vi.advanceTimersByTime(999)
		expect(getCached('k')).toBe('value')
	})

	it('drops a value at its TTL, not merely after it', () => {
		// `expiresAt <= now` — the boundary belongs to the expired side, so a stale report cannot be
		// served for one more millisecond.
		setCached('k', 'value', 1000)
		vi.advanceTimersByTime(1000)
		expect(getCached('k')).toBeUndefined()
	})

	it('evicts on read rather than waiting for a sweep', () => {
		// There is no timer in this module; a serverless instance may never run one.
		setCached('k', 'value', 1000)
		vi.advanceTimersByTime(1000)
		getCached('k')
		// Re-storing with a fresh TTL must work, which it cannot if the stale entry lingers.
		setCached('k', 'second', 1000)
		expect(getCached('k')).toBe('second')
	})

	it('defaults to the documented window', () => {
		setCached('k', 'value')
		vi.advanceTimersByTime(DEFAULT_TTL_MS - 1)
		expect(getCached('k')).toBe('value')
		vi.advanceTimersByTime(1)
		expect(getCached('k')).toBeUndefined()
	})
})

describe('bounding', () => {
	beforeEach(() => { clearCache() })

	it('evicts the oldest entry rather than growing without limit', () => {
		// A long-lived instance must not accumulate every range any editor has ever opened.
		for (let i = 0; i < 200; i++) setCached(`k${i}`, i, 60_000)
		expect(getCached('k0')).toBe(0)
		setCached('overflow', 'new', 60_000)
		expect(getCached('k0')).toBeUndefined()
		expect(getCached('overflow')).toBe('new')
	})

	it('overwrites in place without evicting anything', () => {
		for (let i = 0; i < 200; i++) setCached(`k${i}`, i, 60_000)
		setCached('k5', 'updated', 60_000)
		expect(getCached('k0')).toBe(0)
		expect(getCached('k5')).toBe('updated')
	})
})

describe('withCache', () => {
	beforeEach(() => { clearCache(); vi.useFakeTimers() })
	afterEach(() => { vi.useRealTimers() })

	it('computes once and serves the stored value after', async () => {
		let calls = 0
		const compute = async () => { calls += 1; return calls }
		expect(await withCache('k', 60_000, compute)).toBe(1)
		expect(await withCache('k', 60_000, compute)).toBe(1)
		expect(calls).toBe(1)
	})

	it('lets the caller set a TTL from the result', async () => {
		// The whole point of the callback: a healthy answer keeps the full window, a degraded one is
		// held for seconds so a transient blip does not read as a five-minute outage.
		await withCache('healthy', 60_000, async () => ({ ok: true }), (v) => (v.ok ? 60_000 : 1_000))
		await withCache('degraded', 60_000, async () => ({ ok: false }), (v) => (v.ok ? 60_000 : 1_000))

		vi.advanceTimersByTime(1_000)
		expect(getCached('degraded')).toBeUndefined()
		expect(getCached('healthy')).toBeDefined()
	})

	it('does not store at all when the callback returns zero', async () => {
		let calls = 0
		const compute = async () => { calls += 1; return calls }
		await withCache('k', 60_000, compute, () => 0)
		await withCache('k', 60_000, compute, () => 0)
		expect(calls).toBe(2)
	})

	it('falls back to the fixed TTL when no callback is given', async () => {
		await withCache('k', 1_000, async () => 'value')
		vi.advanceTimersByTime(999)
		expect(getCached('k')).toBe('value')
		vi.advanceTimersByTime(1)
		expect(getCached('k')).toBeUndefined()
	})

	it('does not cache a rejection', async () => {
		// A thrown error must not be stored as an answer — the next caller has to be free to retry.
		await expect(withCache('k', 60_000, async () => { throw new Error('upstream down') }))
			.rejects.toThrow('upstream down')
		expect(getCached('k')).toBeUndefined()
	})
})
