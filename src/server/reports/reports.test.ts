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
