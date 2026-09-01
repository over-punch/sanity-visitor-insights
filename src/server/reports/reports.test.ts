/**
 * Report-layer tests.
 *
 * These run entirely on fakes, so they exercise the reasoning that decides whether a number is
 * trustworthy without needing a GA4 property. The cases below are the ones that would otherwise
 * only surface as a wrong chart in production: an unmeasured step reading as a collapse, a ratio
 * computed across mismatched units, one dead source blanking a whole panel, or a PII field
 * reaching a GROQ projection.
 */

import { describe, expect, it } from 'vitest'
import type { DateRange } from '../../types'
import type { SiteAnalyticsConfig } from '../../core/siteConfig'
import { PREEXISTING } from '../../core/cutover'
import {
	createFakeGa4Client,
	createFakeSanityClient,
	createFakeVercelClient,
	makeGa4Report,
	makeGa4Total,
	makeOrders,
	makeVercelPageviews,
} from '../../testing/fakes'
import { measurementHealth } from './measurementHealth'
import { acquisition } from './acquisition'
import { journey } from './journey'
import { typefaceInterest } from './typefaceInterest'

const range: DateRange = { key: 'week', start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' }

/** A site with full instrumentation, as a baseline to vary from. */
function siteConfig(overrides: Partial<SiteAnalyticsConfig> = {}): SiteAnalyticsConfig {
	return {
		siteId: 'test',
		label: 'Test Foundry',
		ga4: { propertyId: '123456789', timezone: 'UTC' },
		vercel: { projectId: 'prj_test' },
		orders: { documentType: 'order', typefacesField: 'typefaces' },
		eventCutovers: {
			page_view: PREEXISTING,
			view_item: PREEXISTING,
			add_to_cart: PREEXISTING,
			begin_checkout: PREEXISTING,
			purchase: PREEXISTING,
			tester_engaged: PREEXISTING,
			consent_granted: PREEXISTING,
		},
		...overrides,
	}
}

describe('measurementHealth', () => {
	it('compares pageviews to pageviews, not sessions to pageviews', async () => {
		// GA4 pageviews 800, sessions 300, Vercel pageviews 1000.
		// The shortfall must be 20% (against pageviews), not 70% (against sessions).
		const ga4 = createFakeGa4Client({
			batch: () => [makeGa4Total(800), makeGa4Total(300), makeGa4Total(0)],
		})

		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4,
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: null,
		})

		expect(data.shortfallRatio).toBeCloseTo(0.2, 5)
	})

	it('does not compute a shortfall when one pageview source is missing', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(800), makeGa4Total(300), makeGa4Total(0)] }),
			vercel: null,
			sanity: null,
		})

		expect(data.shortfallRatio).toBeNull()
		expect(data.interpretation).toContain('Only one pageview source')
	})

	it('says the residual is unexplained while consent is uninstrumented', async () => {
		const config = siteConfig({
			eventCutovers: { ...siteConfig().eventCutovers, consent_granted: null },
		})

		const data = await measurementHealth({
			config,
			range,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(500), makeGa4Total(300), makeGa4Total(0)] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: null,
		})

		expect(data.consentRate.status).toBe('unavailable')
		expect(data.interpretation).toContain('cannot be measured')
		// Crucially it must not name a cause it has no evidence for.
		expect(data.interpretation).not.toMatch(/ad-?block/i)
	})

	it('attributes part of the gap to consent once that event exists', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(500), makeGa4Total(400), makeGa4Total(300)] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: null,
		})

		// 300 consent events over 400 sessions = 75% granted.
		expect(data.consentRate).toEqual({ status: 'ok', value: 75 })
		expect(data.interpretation).toContain('did not grant analytics consent')
	})

	it('lets one dead source degrade only its own figure', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({ failWith: new Error('GA4 down') }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: createFakeSanityClient(() => makeOrders(['2026-08-21', '2026-08-22'])),
		})

		expect(data.ga4Pageviews.status).toBe('unavailable')
		// Vercel and orders still answered, so they must still be shown.
		expect(data.vercelPageviews).toEqual({ status: 'ok', value: 1000 })
		expect(data.orders).toEqual({ status: 'ok', value: 2 })
	})

	it('never projects a customer field when counting orders', async () => {
		const sanity = createFakeSanityClient(() => makeOrders(['2026-08-21']))

		await measurementHealth({ config: siteConfig(), range, ga4: null, vercel: null, sanity })

		const groq = sanity.queries.map((q) => q.query).join('\n')
		for (const piiField of ['email', 'firstName', 'lastName', 'address', 'last4', 'phone']) {
			expect(groq, `GROQ projected ${piiField}`).not.toContain(piiField)
		}
	})
})

describe('acquisition', () => {
	it('separates design-industry referrers from ordinary traffic', async () => {
		const ga4 = createFakeGa4Client({
			single: () =>
				makeGa4Report([
					{ dimensions: ['fontsinuse.com', 'Referral'], metrics: [200] },
					{ dimensions: ['google', 'Organic Search'], metrics: [700] },
					{ dimensions: ['typewolf.com', 'Referral'], metrics: [100] },
				]),
		})

		const data = await acquisition(ga4, range)

		expect(data.totalSessions).toBe(1000)
		expect(data.designIndustryShare).toBeCloseTo(0.3, 5)
		expect(data.rows.filter((r) => r.designIndustry).map((r) => r.source)).toEqual([
			'fontsinuse.com',
			'typewolf.com',
		])
	})

	it('surfaces unattributed traffic rather than hiding it in the tail', async () => {
		const ga4 = createFakeGa4Client({
			single: () =>
				makeGa4Report([
					{ dimensions: ['(not set)', 'Unassigned'], metrics: [400] },
					{ dimensions: ['google', 'Organic Search'], metrics: [600] },
				]),
		})

		const data = await acquisition(ga4, range)
		expect(data.unattributedShare).toBeCloseTo(0.4, 5)
	})

	it('reports when GA4 withheld rows so the list is not read as complete', async () => {
		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['google', 'Organic Search'], metrics: [10] }], { thresholded: true }),
		})

		expect((await acquisition(ga4, range)).rowsWithheld).toBe(true)
	})
})

describe('journey', () => {
	it('reports an uninstrumented step as unavailable, never as zero', async () => {
		// MCKL's real situation: no begin_checkout at all.
		const config = siteConfig({
			eventCutovers: { ...siteConfig().eventCutovers, begin_checkout: null },
		})

		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(100)) })
		const data = await journey(config, ga4, range)

		const step = data.steps.find((s) => s.event === 'begin_checkout')
		expect(step?.count.status).toBe('unavailable')
		expect(step?.count).not.toMatchObject({ value: 0 })
	})

	it('does not query GA4 for steps it knows cannot return data', async () => {
		const config = siteConfig({
			eventCutovers: { ...siteConfig().eventCutovers, begin_checkout: null, tester_engaged: null },
		})

		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) })
		await journey(config, ga4, range)

		// Six steps, two unqueryable — four requests, so quota is not spent on known-empty events.
		expect(ga4.batchCalls[0]).toHaveLength(4)
	})

	it('does not let an unmeasured rung make the next step look like a collapse', async () => {
		const config = siteConfig({
			eventCutovers: { ...siteConfig().eventCutovers, begin_checkout: null },
		})

		// add_to_cart 200, purchase 50, with begin_checkout unmeasurable between them.
		const counts: Record<string, number> = {
			page_view: 1000,
			view_item: 500,
			tester_engaged: 300,
			add_to_cart: 200,
			purchase: 50,
		}

		const ga4 = createFakeGa4Client({
			batch: (requests) =>
				requests.map((request) => {
					const filter = request.dimensionFilter as { filter?: { stringFilter?: { value?: string } } }
					const event = filter?.filter?.stringFilter?.value ?? ''
					return makeGa4Total(counts[event] ?? 0)
				}),
		})

		const data = await journey(config, ga4, range)
		const purchase = data.steps.find((s) => s.event === 'purchase')

		// Measured against add_to_cart (200), the last step that actually had a number — 25%.
		// Measuring against a missing begin_checkout would have produced a meaningless figure.
		expect(purchase?.conversionFromPrevious).toBeCloseTo(0.25, 5)
	})

	it('always declares itself an approximation', async () => {
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) })
		const data = await journey(siteConfig(), ga4, range)

		expect(data.approximate).toBe(true)
		expect(data.approximationNote).toContain('not tracked journeys')
	})

	it('keeps the funnel when the supplementary exit-page query fails', async () => {
		const ga4: ReturnType<typeof createFakeGa4Client> = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Total(10)),
		})
		// Make only runReport fail, which is what the exit-page query uses.
		ga4.runReport = async () => {
			throw new Error('exits unavailable')
		}

		const data = await journey(siteConfig(), ga4, range)
		expect(data.steps.length).toBeGreaterThan(0)
		expect(data.topExitPages).toEqual([])
	})
})

describe('typefaceInterest', () => {
	it('unions families across sources so one that sold but was never viewed still appears', async () => {
		const ga4 = createFakeGa4Client({
			single: (request) => {
				const filter = request.dimensionFilter as { filter?: { stringFilter?: { value?: string } } }
				const event = filter?.filter?.stringFilter?.value
				if (event === 'view_item') return makeGa4Report([{ dimensions: ['Freight'], metrics: [100] }])
				return makeGa4Report([{ dimensions: ['Freight'], metrics: [40] }])
			},
		})

		const sanity = createFakeSanityClient(() => [{ typefaces: [{ title: 'Omnes' }] }])

		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity })
		expect(data.rows.map((r) => r.typeface).sort()).toEqual(['Freight', 'Omnes'])
	})

	it('computes a test rate only where both sides are real numbers', async () => {
		const ga4 = createFakeGa4Client({
			single: (request) => {
				const filter = request.dimensionFilter as { filter?: { stringFilter?: { value?: string } } }
				const event = filter?.filter?.stringFilter?.value
				if (event === 'view_item') return makeGa4Report([{ dimensions: ['Freight'], metrics: [200] }])
				return makeGa4Report([{ dimensions: ['Freight'], metrics: [50] }])
			},
		})

		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity: null })
		expect(data.rows[0]?.testRate).toBeCloseTo(0.25, 5)
	})

	it('marks tested as unavailable, and the rate as null, when the tester is uninstrumented', async () => {
		const config = siteConfig({
			eventCutovers: { ...siteConfig().eventCutovers, tester_engaged: null },
		})

		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['Freight'], metrics: [200] }]),
		})

		const data = await typefaceInterest({ config, range, ga4, sanity: null })
		expect(data.rows[0]?.tested.status).toBe('unavailable')
		expect(data.rows[0]?.testRate).toBeNull()
	})

	it('reports bought as not applicable when orders do not resolve to typefaces', async () => {
		const config = siteConfig({ orders: { documentType: 'order', typefacesField: null } })

		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['Freight'], metrics: [10] }]),
		})

		const sanity = createFakeSanityClient(() => [])
		const data = await typefaceInterest({ config, range, ga4, sanity })

		expect(data.rows[0]?.bought).toMatchObject({ status: 'unavailable', reason: 'not_applicable' })
	})

	it('applies a site exclude filter so merch cannot inflate a family count', async () => {
		const config = siteConfig({
			orders: { documentType: 'order', typefacesField: 'typefaces', excludeFilter: 'count(merch) == 0' },
		})

		const ga4 = createFakeGa4Client({ single: () => makeGa4Report([]) })
		const sanity = createFakeSanityClient(() => [])

		await typefaceInterest({ config, range, ga4, sanity })
		expect(sanity.queries[0]?.query).toContain('count(merch) == 0')
	})

	it('always carries the note that this is aggregate interest, not one person journey', async () => {
		const ga4 = createFakeGa4Client({ single: () => makeGa4Report([]) })
		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity: null })

		expect(data.interpretationNote).toContain('not individual journeys')
	})
})

describe('data-quality flags reach the surface', () => {
	it('reports GA4 thresholding on the typeface table instead of claiming it is complete', async () => {
		// This was hardcoded false, so quiet families vanished and the table read as exhaustive.
		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['Omnes'], metrics: [10] }], { thresholded: true }),
		})

		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity: null })
		expect(data.rowsWithheld).toBe(true)
	})

	it('warns when GA4 answered from a sample rather than presenting estimates as exact', async () => {
		const notices: string[] = []
		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['google', 'Organic Search'], metrics: [10] }], { sampled: true }),
		})

		await acquisition(ga4, range, 25, notices)
		expect(notices.some((n) => n.includes('sample'))).toBe(true)
	})

	it('warns about sampling in the funnel too', async () => {
		const notices: string[] = []
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Report([{ metrics: [10] }], { sampled: true })),
		})

		await journey(siteConfig(), ga4, range, notices)
		expect(notices.some((n) => n.includes('sample'))).toBe(true)
	})

	it('stays quiet when nothing was sampled or withheld', async () => {
		const notices: string[] = []
		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['google', 'Organic Search'], metrics: [10] }]),
		})

		const data = await acquisition(ga4, range, 25, notices)
		expect(notices).toEqual([])
		expect(data.rowsWithheld).toBe(false)
	})
})

describe('per-site event names', () => {
	// TDF's real situation: five long-standing tester events and no `tester_engaged`.
	const tdfTesterEvents = ['variable_font_change', 'variable_style_change', 'style_change', 'feature_change', 'opentype_feature']

	function tdfConfig(): SiteAnalyticsConfig {
		return siteConfig({
			eventNames: { tester: tdfTesterEvents },
			eventCutovers: {
				page_view: PREEXISTING, view_item: PREEXISTING, add_to_cart: PREEXISTING,
				begin_checkout: PREEXISTING, purchase: PREEXISTING,
				...Object.fromEntries(tdfTesterEvents.map((e) => [e, PREEXISTING])),
			},
		})
	}

	it('treats a site’s own tester events as the tester step', async () => {
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(500)) })
		const data = await journey(tdfConfig(), ga4, range)

		const tester = data.steps.find((s) => s.key === 'tested')
		// Without the mapping this would be unavailable, discarding data the site already has.
		expect(tester?.count.status).toBe('ok')
	})

	it('queries GA4 for the site’s events rather than the canonical name', async () => {
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) })
		await journey(tdfConfig(), ga4, range)

		const filters = JSON.stringify(ga4.batchCalls[0]?.map((r) => r.dimensionFilter))
		expect(filters).toContain('variable_font_change')
		expect(filters).not.toContain('tester_engaged')
	})

	it('sums tester counts per typeface across the site’s events', async () => {
		const ga4 = createFakeGa4Client({
			single: (request) => {
				const f = JSON.stringify(request.dimensionFilter)
				if (f.includes('view_item')) return makeGa4Report([{ dimensions: ['Bogart'], metrics: [400] }])
				// Each of the five tester events contributes 20 for the same family.
				return makeGa4Report([{ dimensions: ['Bogart'], metrics: [20] }])
			},
		})

		const data = await typefaceInterest({ config: tdfConfig(), range, ga4, sanity: null })
		const row = data.rows.find((r) => r.typeface === 'Bogart')
		expect(row?.tested).toEqual({ status: 'ok', value: 100 })
		expect(row?.testRate).toBeCloseTo(0.25, 5)
	})

	it('still uses the default name when a site does not map its own', async () => {
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) })
		await journey(siteConfig(), ga4, range)

		expect(JSON.stringify(ga4.batchCalls[0]?.map((r) => r.dimensionFilter))).toContain('tester_engaged')
	})
})

describe('journey counts people, not events', () => {
	it('asks GA4 for users rather than event counts', async () => {
		// add_to_cart fires on every selection change on two of the three sites — 5.0 and 3.4
		// events per user — so an event-count funnel divides an engagement-inflated number by one
		// that fires once per order, and calls the result a conversion rate.
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) })
		await journey(siteConfig(), ga4, range)

		const metrics = ga4.batchCalls[0]?.flatMap((r) => (r.metrics ?? []).map((m) => m.name))
		expect(metrics).not.toContain('eventCount')
		expect(new Set(metrics)).toEqual(new Set(['totalUsers']))
	})
})

/**
 * The daily series.
 *
 * Built because a scalar shortfall could not distinguish Darden's overnight 86% measurement failure
 * on 2026-08-24 from a gap that had always been there. The two need opposite responses.
 */
describe('measurementHealth daily series', () => {
	const threeDays: DateRange = { key: 'week', start: '2026-08-20', end: '2026-08-22', timezone: 'UTC' }

	it('pairs the two sources by date, oldest first', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range: threeDays,
			ga4: createFakeGa4Client({
				batch: () => [
					makeGa4Total(1282),
					makeGa4Total(800),
					makeGa4Total(0),
					makeGa4Report([
						{ dimensions: ['20260820'], metrics: [471] },
						{ dimensions: ['20260821'], metrics: [422] },
						{ dimensions: ['20260822'], metrics: [389] },
					]),
				],
			}),
			vercel: createFakeVercelClient(makeVercelPageviews({
				'2026-08-20': 494, '2026-08-21': 503, '2026-08-22': 387,
			})),
			sanity: null,
		})

		expect(data.daily).toEqual([
			{ date: '2026-08-20', ga4: 471, vercel: 494 },
			{ date: '2026-08-21', ga4: 422, vercel: 503 },
			{ date: '2026-08-22', ga4: 389, vercel: 387 },
		])
	})

	it('reports a day a source did not answer as null, never as zero', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range: threeDays,
			ga4: createFakeGa4Client({
				batch: () => [
					makeGa4Total(860),
					makeGa4Total(500),
					makeGa4Total(0),
					makeGa4Report([
						{ dimensions: ['20260820'], metrics: [471] },
						{ dimensions: ['20260822'], metrics: [389] },
					]),
				],
			}),
			vercel: createFakeVercelClient(makeVercelPageviews({
				'2026-08-20': 494, '2026-08-21': 503, '2026-08-22': 387,
			})),
			sanity: null,
		})

		const middle = data.daily.find((d) => d.date === '2026-08-21')
		expect(middle?.ga4).toBeNull()
		expect(middle?.vercel).toBe(503)
	})
})

/**
 * The implausibility band. A gap larger than consent and blocking can account for has to be named
 * as a probable measurement failure, not framed as expected loss with an unexplained remainder.
 * Darden ran at 86% for over a week and the panel's wording never changed.
 */
describe('measurementHealth interpretation', () => {
	it('calls a very large gap a measurement failure', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(475), makeGa4Total(357), makeGa4Total(0), makeGa4Report([])] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 2356 })),
			sanity: null,
		})

		expect(data.interpretation).toContain('measurement failure')
	})

	it('still frames a modest gap as expected loss', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(900), makeGa4Total(700), makeGa4Total(0), makeGa4Report([])] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: null,
		})

		expect(data.interpretation).not.toContain('measurement failure')
	})
})
