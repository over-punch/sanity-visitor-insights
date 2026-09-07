/**
 * Tests for the real Vercel client.
 *
 * It had none. The test double in `testing/fakes.ts` implements `pageviews()` by returning a
 * fixture, so no test had ever reached the client's chunking, its day filtering, its totals
 * derivation or its failure reporting — and a review's mutation table showed that deleting the
 * range filter, hard-coding `incompleteWindows` to zero, or switching the total between its two
 * sources all left the suite green.
 *
 * `fetch` is stubbed per test rather than mocked at module level, so each case states exactly what
 * the API gave back and what the client made of it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVercelClient, dailyWindows, granularityFor } from './vercel'

/** One aggregate bucket, as the API returns it. */
function bucket(day: string, pageviews: number) {
	return { timestamp: `${day}T00:00:00.000Z`, pageviews, visitors: pageviews }
}

/**
 * Stub `fetch` for the two endpoints the client calls.
 *
 * @param series - buckets to return from `visits/aggregate`, or a thrower per call index
 * @param totals - what `visits/count` reports for the whole range
 */
function stubFetch(
	series: Array<ReturnType<typeof bucket>> | ((call: number) => Array<ReturnType<typeof bucket>>),
	totals: { pageviews?: number; visitors?: number } | null = { pageviews: 999, visitors: 500 },
) {
	let aggregateCalls = 0
	const urls: string[] = []
	globalThis.fetch = (async (url: string) => {
		urls.push(url)
		const isCount = url.includes('visits/count')
		const body = isCount
			? { data: totals }
			: { data: typeof series === 'function' ? series(aggregateCalls++) : series }
		return { ok: true, status: 200, async json() { return body } }
	}) as unknown as typeof fetch
	return urls
}

const client = () => createVercelClient('token', 'proj', 'team')

afterEach(() => { vi.restoreAllMocks() })

describe('the day series', () => {
	it('keeps only days inside the requested range', async () => {
		// The API is asked for a range but the response is not trusted to respect it.
		stubFetch([bucket('2026-08-19', 10), bucket('2026-08-20', 100), bucket('2026-08-26', 200), bucket('2026-08-27', 20)])
		const result = await client().pageviews('2026-08-20', '2026-08-26')
		expect(Object.keys(result.byDate).sort()).toEqual(['2026-08-20', '2026-08-26'])
	})

	it('sums repeated buckets for one day rather than overwriting', async () => {
		// Chunked fetches can return the same day twice at a window boundary; the second must not
		// silently replace the first.
		stubFetch([bucket('2026-08-20', 100), bucket('2026-08-20', 50)])
		const result = await client().pageviews('2026-08-20', '2026-08-26')
		expect(result.byDate['2026-08-20']).toBe(150)
	})

	it('ignores a bucket with no timestamp instead of keying it undefined', async () => {
		stubFetch([{ pageviews: 100 } as never, bucket('2026-08-21', 40)])
		const result = await client().pageviews('2026-08-20', '2026-08-26')
		expect(Object.keys(result.byDate)).toEqual(['2026-08-21'])
	})
})

describe('the range total', () => {
	it('comes from the day series when that series is whole', async () => {
		// Summing the days covers exactly the window asked for; the count endpoint's bare dates are
		// read in UTC and can start and end elsewhere.
		stubFetch([bucket('2026-08-20', 100), bucket('2026-08-21', 200)], { pageviews: 999, visitors: 40 })
		const result = await client().pageviews('2026-08-20', '2026-08-26')
		expect(result.total).toBe(300)
	})

	it('falls back to the count endpoint when a window failed', async () => {
		// A hole in the series must not be published as a smaller total.
		let call = 0
		globalThis.fetch = (async (url: string) => {
			if (url.includes('visits/count')) {
				return { ok: true, status: 200, async json() { return { data: { pageviews: 999, visitors: 40 } } } }
			}
			call += 1
			if (call === 1) throw new Error('window down')
			return { ok: true, status: 200, async json() { return { data: [bucket('2026-08-20', 100)] } } }
		}) as unknown as typeof fetch

		const result = await client().pageviews('2026-08-20', '2026-08-26')
		expect(result.incompleteWindows).toBe(1)
		expect(result.total).toBe(999)
	})

	it('reports an absent visitor count as absent, never as zero', async () => {
		// This panel exists to tell "measured nothing" from "did not measure", and has to hold itself
		// to that first.
		stubFetch([bucket('2026-08-20', 100)], {})
		const result = await client().pageviews('2026-08-20', '2026-08-26')
		expect(result.visitors).toBeNull()
	})

	it('does not sum daily visitors, which would double-count returning people', async () => {
		// A person visiting on three days is three daily visitors and one range visitor.
		stubFetch([bucket('2026-08-20', 100), bucket('2026-08-21', 100)], { pageviews: 999, visitors: 40 })
		const result = await client().pageviews('2026-08-20', '2026-08-26')
		expect(result.visitors).toBe(40)
	})
})

describe('long ranges', () => {
	it('splits a quarter into day-bucketed windows', async () => {
		const urls = stubFetch(() => [bucket('2026-08-20', 10)])
		await client().pageviews('2026-06-08', '2026-09-05')
		const aggregates = urls.filter((u) => u.includes('visits/aggregate'))
		expect(aggregates.length).toBe(dailyWindows('2026-06-08', '2026-09-05').length)
		for (const url of aggregates) expect(url).toContain('by=day')
	})

	it('reports a coarse fallback as not daily, so its total is not published as one', async () => {
		// Beyond the window cap the client makes one `by: month` call. Summing month buckets and
		// filtering them by a day comparison drops one straddling the start and keeps one straddling
		// the end — and `incompleteWindows` stays zero, so the flag built to say "do not trust this"
		// reported it sound.
		const urls = stubFetch([bucket('2025-09-01', 5000)])
		const result = await client().pageviews('2025-08-15', '2026-09-05')
		expect(urls.some((u) => u.includes(`by=${granularityFor('2025-08-15', '2026-09-05')}`))).toBe(true)
		expect(result.daily).toBe(false)
		expect(result.total).toBe(999)
	})
})
