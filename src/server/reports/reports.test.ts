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
import { hasRequiredRole } from '../auth'
import { parseFunnelReport } from '../ga4'
import { ENV_VARS, createVisitorInsightsHandler } from '../createHandler'
import type { HandlerRequest, HandlerResponse } from '../auth'
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
		expect(data.topLandingPages).toEqual([])
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

		// No rate, deliberately. This assertion used to expect 0.25. Summing distinct-user counts
		// across five events double-counts anyone who fired more than one of them, so the ratio is
		// not a proportion and printing it as a percentage under a column headed "Test rate" states
		// something the data cannot support. The tested count itself is still useful and still shown.
		expect(row?.testRate).toBeNull()
	})

	it('does give a rate when one event serves the tester step', async () => {
		const ga4 = createFakeGa4Client({
			single: (request) => {
				const f = JSON.stringify(request.dimensionFilter)
				if (f.includes('view_item')) return makeGa4Report([{ dimensions: ['Bogart'], metrics: [400] }])
				return makeGa4Report([{ dimensions: ['Bogart'], metrics: [100] }])
			},
		})

		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity: null })
		expect(data.rows.find((r) => r.typeface === 'Bogart')?.testRate).toBeCloseTo(0.25, 5)
	})

	it('never reports a test rate above 100%', async () => {
		const ga4 = createFakeGa4Client({
			single: (request) => {
				const f = JSON.stringify(request.dimensionFilter)
				if (f.includes('view_item')) return makeGa4Report([{ dimensions: ['Bogart'], metrics: [10] }])
				return makeGa4Report([{ dimensions: ['Bogart'], metrics: [40] }])
			},
		})

		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity: null })
		expect(data.rows.find((r) => r.typeface === 'Bogart')?.testRate).toBe(1)
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

/**
 * Denominators and rates.
 *
 * Three numbers the tool used to print that were wrong rather than merely imprecise. Each was
 * flagged independently by more than one reviewer in the 2026-09-01 design review.
 */
describe('shares are measured against the whole, or withheld', () => {
	it('uses GA4 total across all rows, not the sum of the returned ones', async () => {
		const ga4 = createFakeGa4Client({
			single: () => ({
				...makeGa4Report([
					{ dimensions: ['fontsinuse.com', 'Referral'], metrics: [100] },
					{ dimensions: ['google', 'Organic Search'], metrics: [100] },
				]),
				// GA4 held 1,000 sessions in total; the query returned the top two rows.
				rowCount: 40,
				metricTotal: 1000,
			}),
		})

		const data = await acquisition(ga4, range)

		expect(data.totalSessions).toBe(1000)
		// 100 of 1,000, not 100 of the 200 that came back.
		expect(data.designIndustryShare).toBeCloseTo(0.1, 5)
		expect(data.rowsTruncated).toBe(true)
	})

	it('withholds the shares when the true total is unavailable and rows were truncated', async () => {
		const ga4 = createFakeGa4Client({
			single: () => ({
				...makeGa4Report([{ dimensions: ['fontsinuse.com', 'Referral'], metrics: [100] }]),
				rowCount: 40,
			}),
		})

		const data = await acquisition(ga4, range)

		// A share of an unknown whole is not a smaller truth; it is a different number.
		expect(data.designIndustryShare).toBeNull()
		expect(data.unattributedShare).toBeNull()
	})
})

/**
 * Role enforcement. The plugin option only hid the tab; the route itself was open to any Studio
 * user of the project, while the README said otherwise.
 */
describe('hasRequiredRole', () => {
	const user = (roles: string[]) => ({ id: 'u1', roles: roles.map((name) => ({ name })) })

	it('admits a user holding one of the required roles', () => {
		expect(hasRequiredRole(user(['editor', 'administrator']), ['administrator'])).toBe(true)
	})

	it('refuses a user holding none of them', () => {
		expect(hasRequiredRole(user(['editor']), ['administrator'])).toBe(false)
	})

	it('refuses a user with no roles at all — absence is not permission', () => {
		expect(hasRequiredRole({ id: 'u1' }, ['administrator'])).toBe(false)
	})

	it('admits anyone when no roles are required', () => {
		expect(hasRequiredRole({ id: 'u1' }, [])).toBe(true)
	})
})

describe('journey funnel', () => {
	/** A funnel response echoing the step names it was given, with GA4's own completion rates. */
	function funnelFor(counts: Record<string, number>) {
		const names = Object.keys(counts)
		return {
			sampled: false,
			steps: names.map((name, index) => {
				const previous = index > 0 ? counts[names[index - 1]!]! : null
				return {
					name,
					activeUsers: counts[name]!,
					completionRate: previous && previous > 0 ? counts[name]! / previous : null,
					abandonments: null,
				}
			}),
		}
	}

	it('prefers the tracked funnel and says so', async () => {
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Total(999)),
			funnel: () =>
				funnelFor({
					Landed: 1000,
					'Viewed a typeface': 400,
					'Used the type tester': 120,
					'Added to cart': 60,
					'Began checkout': 30,
					Purchased: 10,
				}),
		})

		const result = await journey(siteConfig(), ga4, range, [])

		expect(result.measurement).toBe('sequence')
		expect(result.approximate).toBe(false)
		// The funnel's numbers, not the per-step batch's 999 — proving the batch result did not win.
		expect(result.steps.map((step) => (step.count.status === 'unavailable' ? null : step.count.value)))
			.toEqual([1000, 400, 120, 60, 30, 10])
		expect(result.steps[1]?.conversionFromPrevious).toBeCloseTo(0.4, 5)
		expect(result.steps[0]?.conversionFromPrevious).toBeNull()
	})

	it('asks for the steps in funnel order, one event filter each', async () => {
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Total(1)),
			funnel: () => funnelFor({ Landed: 10 }),
		})

		await journey(siteConfig(), ga4, range, [])

		expect(ga4.funnelCalls).toHaveLength(1)
		expect(ga4.funnelCalls[0]?.steps.map((step) => step.name)).toEqual([
			'Landed',
			'Viewed a typeface',
			'Used the type tester',
			'Added to cart',
			'Began checkout',
			'Purchased',
		])
		expect(ga4.funnelCalls[0]?.range).toEqual({ startDate: range.start, endDate: range.end })
	})

	it('falls back to per-step totals when the funnel endpoint fails', async () => {
		// The default fake rejects funnels, which is the state on any property where the alpha
		// endpoint is unavailable or its quota is spent.
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(50)) })

		const result = await journey(siteConfig(), ga4, range, [])

		expect(result.measurement).toBe('independent-totals')
		expect(result.approximate).toBe(true)
		expect(result.approximationNote).toContain('not tracked journeys')
		expect(result.steps.every((step) => step.count.status !== 'unavailable')).toBe(true)
	})

	it('falls back rather than lining up steps GA4 did not answer for', async () => {
		// A partial response is the dangerous case: matching by position would attach one step's
		// users to another step's label, and the panel would show a confident wrong funnel.
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Total(50)),
			funnel: () => funnelFor({ Landed: 1000, 'Added to cart': 60 }),
		})

		const result = await journey(siteConfig(), ga4, range, [])

		expect(result.measurement).toBe('independent-totals')
	})

	it('does not attempt a funnel with fewer than two measured steps', async () => {
		// Every step but one uninstrumented: a one-rung funnel is a count, and spending the alpha
		// quota on it buys nothing.
		const config = siteConfig({
			eventCutovers: {
				page_view: PREEXISTING,
				view_item: null,
				add_to_cart: null,
				begin_checkout: null,
				purchase: null,
				tester_engaged: null,
			},
		})
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Total(50)),
			funnel: () => funnelFor({ Landed: 1000 }),
		})

		await journey(config, ga4, range, [])

		expect(ga4.funnelCalls).toHaveLength(0)
	})

	it('notes sampling on a sampled funnel', async () => {
		const notices: string[] = []
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Total(1)),
			funnel: () => ({ ...funnelFor({ Landed: 10, 'Viewed a typeface': 5 }), sampled: true }),
		})

		await journey(siteConfig(), ga4, range, notices)

		expect(notices.some((notice) => notice.includes('sample'))).toBe(true)
	})
})

describe('parseFunnelReport', () => {
	/** GA4 prefixes step names with an ordinal, and the parser is expected to strip it. */
	const headers = {
		dimensionHeaders: [{ name: 'funnelStepName' }],
		metricHeaders: [
			{ name: 'activeUsers' },
			{ name: 'funnelStepCompletionRate' },
			{ name: 'funnelStepAbandonments' },
		],
	}

	it('reads metrics by header name, not by position', () => {
		// Same data, metric headers in a different order. Reading metricValues[0] would report
		// the completion rate as a user count.
		const shuffled = {
			funnelTable: {
				dimensionHeaders: headers.dimensionHeaders,
				metricHeaders: [
					{ name: 'funnelStepCompletionRate' },
					{ name: 'funnelStepAbandonments' },
					{ name: 'activeUsers' },
				],
				rows: [
					{ dimensionValues: [{ value: '1. Landed' }], metricValues: [{ value: '1' }, { value: '0' }, { value: '900' }] },
				],
			},
		}

		expect(parseFunnelReport(shuffled).steps).toEqual([
			{ name: 'Landed', activeUsers: 900, completionRate: 1, abandonments: 0 },
		])
	})

	it('strips the ordinal prefix so step names match the ones that were sent', () => {
		const raw = {
			funnelTable: {
				...headers,
				rows: [
					{ dimensionValues: [{ value: '2. Viewed a typeface' }], metricValues: [{ value: '400' }, { value: '0.4' }, { value: '250' }] },
				],
			},
		}

		// The journey report matches rows to rungs by name; an unstripped "2. " would never match
		// and every funnel would silently fall back to per-step totals.
		expect(parseFunnelReport(raw).steps[0]?.name).toBe('Viewed a typeface')
	})

	it('takes only the totals row when a breakdown dimension is present', () => {
		// A breakdown adds a dimension and one row per value alongside the RESERVED_TOTAL row.
		// Summing them, or taking the first, would report one device category as the whole step.
		const raw = {
			funnelTable: {
				dimensionHeaders: [{ name: 'funnelStepName' }, { name: 'deviceCategory' }],
				metricHeaders: headers.metricHeaders,
				rows: [
					{ dimensionValues: [{ value: '1. Landed' }, { value: 'desktop' }], metricValues: [{ value: '600' }, { value: '1' }, { value: '0' }] },
					{ dimensionValues: [{ value: '1. Landed' }, { value: 'mobile' }], metricValues: [{ value: '300' }, { value: '1' }, { value: '0' }] },
					{ dimensionValues: [{ value: '1. Landed' }, { value: 'RESERVED_TOTAL' }], metricValues: [{ value: '900' }, { value: '1' }, { value: '0' }] },
				],
			},
		}

		expect(parseFunnelReport(raw).steps).toHaveLength(1)
		expect(parseFunnelReport(raw).steps[0]?.activeUsers).toBe(900)
	})

	it('returns no steps rather than guessing when the table is missing', () => {
		expect(parseFunnelReport({})).toEqual({ steps: [], sampled: false })
	})

	it('drops a row whose user count is absent rather than reading it as zero', () => {
		const raw = {
			funnelTable: {
				...headers,
				rows: [
					{ dimensionValues: [{ value: '1. Landed' }], metricValues: [{ value: '900' }, { value: '1' }, { value: '0' }] },
					{ dimensionValues: [{ value: '2. Purchased' }], metricValues: [{}, {}, {}] },
				],
			},
		}

		expect(parseFunnelReport(raw).steps.map((step) => step.name)).toEqual(['Landed'])
	})
})

describe('the handler master switch', () => {
	/** Record what the handler sent, without a Next.js response object. */
	function recorder() {
		const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} }
		const res: HandlerResponse = {
			setHeader: (name, value) => { sent.headers[name] = value },
			status(code) { sent.status = code; return res },
			json(body) { sent.body = body },
			end() {},
		}
		return { sent, res }
	}

	const req: HandlerRequest = {
		method: 'GET',
		headers: { authorization: 'Bearer a-studio-session-token' },
		query: { report: 'acquisition', range: 'week' },
	}

	const handler = createVisitorInsightsHandler({ config: siteConfig(), sanityProjectId: 'p1' })

	it('answers 503 and does no upstream work when the switch is off', async () => {
		const previous = process.env[ENV_VARS.enabled]
		delete process.env[ENV_VARS.enabled]
		try {
			const { sent, res } = recorder()
			await handler(req, res)
			expect(sent.status).toBe(503)
			expect(sent.body).toMatchObject({ disabled: true })
			// The message must name the variable: the Studio is where an operator will read this,
			// and "switched off" without saying which switch is not actionable.
			expect((sent.body as { error: string }).error).toContain(ENV_VARS.enabled)
		} finally {
			if (previous !== undefined) process.env[ENV_VARS.enabled] = previous
		}
	})

	it('gets past the switch when it is truthy, and fails later for its own reasons', async () => {
		const previous = process.env[ENV_VARS.enabled]
		process.env[ENV_VARS.enabled] = 'darden-2026'
		try {
			const { sent, res } = recorder()
			await handler(req, res)
			// Any status but 503-disabled proves the gate opened. This request then fails on the
			// Sanity token, which is the correct next check and is not what is under test here.
			expect(sent.body).not.toMatchObject({ disabled: true })
		} finally {
			if (previous === undefined) delete process.env[ENV_VARS.enabled]
			else process.env[ENV_VARS.enabled] = previous
		}
	})
})
