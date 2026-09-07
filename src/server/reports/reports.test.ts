/**
 * Report-layer tests.
 *
 * These run entirely on fakes, so they exercise the reasoning that decides whether a number is
 * trustworthy without needing a GA4 property. The cases below are the ones that would otherwise
 * only surface as a wrong chart in production: an unmeasured step reading as a collapse, a ratio
 * computed across mismatched units, one dead source blanking a whole panel, or a PII field
 * reaching a GROQ projection.
 */

import { fetchWithTimeout } from '../fetchWithTimeout'
import { alignBatch, type Ga4Report } from '../ga4'
import { formatInTimeZone } from '../../core/ranges'
import { countLicenceTiers } from '../orders'
import { describe, expect, it, vi } from 'vitest'

// The GA4 client signs a service-account JWT before every call. These tests are about the request
// BODY, not the credential, so the token exchange is stubbed rather than fed a fabricated RSA key.
vi.mock('../googleAuth', () => ({
	getAccessToken: async () => 'test-token',
	parseServiceAccountKey: (raw?: string) => (raw ? { client_email: 'x', private_key: 'y' } : null),
}))
import type { DateRange } from '../../types'
import type { SiteAnalyticsConfig } from '../../core/siteConfig'
import { PREEXISTING } from '../../core/cutover'
import {
	createFakeGa4Client,
	createFakeSanityClient,
	createFakeMailchimpClient,
	createFakeVercelClient,
	makeGa4Report,
	makeGa4Total,
	makeOrders,
	makeVercelPageviews,
} from '../../testing/fakes'
import { hasRequiredRole } from '../auth'
import { countOrders, countOrdersByTypeface, orderQueryOptions } from '../orders'
import { andFilters, createGa4Client, eventNameFilter, hostnameFilter } from '../ga4'
import { createMailchimpClient, datacenterFromKey } from '../mailchimp'
import { previousRange, zonedDayEndUtc, zonedDayStartUtc } from '../../core/ranges'
import { parseFunnelReport } from '../ga4'
import { COMPARED_REPORTS, ENV_VARS, createVisitorInsightsHandler } from '../createHandler'
import type { HandlerRequest, HandlerResponse } from '../auth'
import { attributeToSends, measurementHealth } from './measurementHealth'
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

	it('excludes GA4\u2019s unprocessed days from the shortfall', async () => {
		/*
		 * The headline fix of the settled-day change, and until the clock became injectable nothing
		 * reached it: every fixture uses a fixed past range, so no day is provisional and each test
		 * exercised the fallback. Reverting the whole thing left the suite green.
		 *
		 * Here "now" is the 26th — the last day of the range — so the 25th and 26th are still
		 * settling. GA4 reports nothing for those two days while Vercel reports its usual traffic,
		 * which is the exact shape of the artefact.
		 */
		const daily: Record<string, number> = {}
		const ga4Rows: Array<{ dimensions: string[]; metrics: number[] }> = []
		for (let day = 20; day <= 26; day += 1) {
			const date = `2026-08-${day}`
			daily[date] = 100
			// GA4 has settled figures through the 24th and nothing after.
			// GA4 returns YYYYMMDD, not ISO — the report converts it.
			ga4Rows.push({ dimensions: [`202608${day}`], metrics: [day <= 24 ? 80 : 0] })
		}

		const data = await measurementHealth({
			config: siteConfig(),
			range,
			now: new Date('2026-08-26T12:00:00Z'),
			ga4: createFakeGa4Client({
				batch: () => [
					makeGa4Total(400),
					makeGa4Report([{ metrics: [400, 320] }]),
					makeGa4Total(0),
					makeGa4Report(ga4Rows),
				],
			}),
			vercel: createFakeVercelClient(makeVercelPageviews(daily)),
			sanity: null,
		})

		// Settled days only: 5 days of 80 GA4 against 5 days of 100 Vercel = a fifth missing.
		// Counting the two unsettled days would make it 400/700, i.e. 43% — more than twice the
		// truth, and a third of the way to the verdict's "treat its figures as broken" line.
		expect(data.shortfallRatio).toBeCloseTo(0.2, 2)
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

	it('reports the consent rate without crediting it for the gap', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({
				batch: () => [
					makeGa4Total(500),
					// The sessions report carries a second metric, totalUsers, which is the consent
					// denominator: 400 sessions from 320 people.
					makeGa4Report([{ metrics: [400, 320] }]),
					makeGa4Total(240),
				],
			}),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: null,
		})

		// 240 consenting users over 320 users = 75%. Users on both sides, not events over sessions.
		expect(data.consentRate).toEqual({ status: 'ok', value: 75 })
		// The rate is measured INSIDE GA4's sample — conditioned on having been seen at all — so
		// anyone who refused before being counted is in neither the numerator nor the denominator.
		// It used to be offered as accounting for "part of" the GA4-versus-Vercel residual, which is
		// a population it cannot describe.
		expect(data.interpretation).toContain('declined analytics consent')
		expect(data.interpretation).toContain('does not explain the visitors missing from it')
		expect(data.interpretation).not.toContain('accounts for part of it')
		// An UPPER bound on decliners, because `grants` is a Math.max across event rows and is
		// therefore a lower bound on granters. This test previously asserted "at least" and reasoned
		// its way to the wrong sign in its own comment — so it did not merely miss the bug, it would
		// have blocked the fix.
		expect(data.interpretation).toContain('at most')
		expect(data.interpretation).not.toContain('at least')
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

		const data = await acquisition({ config: siteConfig(), range, ga4 })

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

		const data = await acquisition({ config: siteConfig(), range, ga4 })
		expect(data.unattributedShare).toBeCloseTo(0.4, 5)
	})

	it('reports when GA4 withheld rows so the list is not read as complete', async () => {
		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['google', 'Organic Search'], metrics: [10] }], { thresholded: true }),
		})

		expect((await acquisition({ config: siteConfig(), range, ga4 })).rowsWithheld).toBe(true)
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

		await acquisition({ config: siteConfig(), range, ga4, notices })
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

		const data = await acquisition({ config: siteConfig(), range, ga4, notices })
		// Specifically about quality flags. The fake answers both the session and the purchase query
		// with the same report, so it also exercises the purchase path — which legitimately reports
		// that GA4 attributed sales with no revenue against them. That is a real finding, not noise,
		// and it is not what this test is about.
		expect(notices.filter((n) => /sample|withheld|truncated/i.test(n))).toEqual([])
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

		const data = await acquisition({ config: siteConfig(), range, ga4 })

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

		const data = await acquisition({ config: siteConfig(), range, ga4 })

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
			// Asserted as a specific 401, not merely "not disabled". The looser form passed for a
			// 405, a 400, a 502 and a thrown exception — every outcome except the one it excluded.
			expect(sent.status).toBe(401)
			expect(sent.body).not.toMatchObject({ disabled: true })
		} finally {
			if (previous === undefined) delete process.env[ENV_VARS.enabled]
			else process.env[ENV_VARS.enabled] = previous
		}
	})
})

describe('order figures', () => {
	/** A Sanity fake returning fixed documents and recording the params it was bound with. */
	function ordersClient(docs: unknown[]) {
		const calls: Array<Record<string, unknown> | undefined> = []
		return {
			calls,
			async fetch<T>(_query: string, params?: Record<string, unknown>): Promise<T> {
				calls.push(params)
				return docs as T
			},
		}
	}

	const base = { start: '2026-08-20', end: '2026-08-26', timezone: 'America/Los_Angeles' }

	it('bounds the query in the property timezone, not UTC', async () => {
		// The bug this pins: bounding with a bare `${date}T00:00:00Z` asked Sanity for a different
		// seven days than GA4 was asked for — seven hours out for a US-Pacific property, always in
		// the same direction. At a handful of orders a day that is a visible swing.
		const client = ordersClient([])
		await countOrders(client, orderQueryOptions({ documentType: 'order' }, base))

		expect(client.calls[0]?.start).toBe(zonedDayStartUtc('2026-08-20', 'America/Los_Angeles'))
		expect(client.calls[0]?.end).toBe(zonedDayEndUtc('2026-08-26', 'America/Los_Angeles'))
		// Pacific daylight time is UTC-7, so the local day starts at 07:00Z.
		expect(client.calls[0]?.start).toBe('2026-08-20T07:00:00.000Z')
	})

	it('counts every status when no allow-list is configured, and reports the vocabulary', async () => {
		const client = ordersClient([
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete' },
			{ _createdAt: '2026-08-21T13:00:00Z', status: 'test' },
			{ _createdAt: '2026-08-22T09:00:00Z', status: null },
		])

		const counts = await countOrders(client, orderQueryOptions({ documentType: 'order' }, base))

		expect(counts.total).toBe(3)
		expect(counts.statusFiltered).toBe(false)
		// The breakdown is always reported: an operator cannot configure countedStatuses without
		// first seeing what their own orders actually say.
		expect(counts.byStatus).toEqual({ complete: 1, test: 1, '(no status)': 1 })
	})

	it('excludes orders outside the status allow-list and says how many', async () => {
		const client = ordersClient([
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete' },
			{ _createdAt: '2026-08-21T13:00:00Z', status: 'test' },
			{ _createdAt: '2026-08-22T09:00:00Z', status: 'refunded' },
		])

		const counts = await countOrders(
			client,
			orderQueryOptions({ documentType: 'order', countedStatuses: ['complete'] }, base),
		)

		expect(counts.total).toBe(1)
		expect(counts.excludedByStatus).toBe(2)
		expect(counts.statusFiltered).toBe(true)
	})

	it('matches statuses case-insensitively', async () => {
		const client = ordersClient([{ _createdAt: '2026-08-21T12:00:00Z', status: 'Complete' }])
		const counts = await countOrders(
			client,
			orderQueryOptions({ documentType: 'order', countedStatuses: ['complete'] }, base),
		)
		expect(counts.total).toBe(1)
	})

	it('reports revenue as null rather than zero when no total field is configured', async () => {
		// Null and zero are different answers: one means "not measured here", the other "sold
		// nothing". Rendering them alike is the defect this whole codebase exists to avoid.
		const client = ordersClient([{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete' }])
		const counts = await countOrders(client, orderQueryOptions({ documentType: 'order' }, base))
		expect(counts.revenue).toBeNull()
		expect(counts.revenueByDate).toBeNull()
	})

	it('sums revenue and buckets it by day when a total field is configured', async () => {
		const client = ordersClient([
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete', orderTotal: 120 },
			{ _createdAt: '2026-08-21T18:00:00Z', status: 'complete', orderTotal: 40 },
			{ _createdAt: '2026-08-22T09:00:00Z', status: 'complete', orderTotal: 400 },
		])

		const counts = await countOrders(
			client,
			orderQueryOptions({ documentType: 'order', totalField: 'total' }, base),
		)

		expect(counts.revenue).toBe(560)
		expect(counts.revenueByDate).toEqual({ '2026-08-21': 160, '2026-08-22': 400 })
	})

	it('ignores a total that is not a finite number', async () => {
		const client = ordersClient([
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete', orderTotal: '120' },
			{ _createdAt: '2026-08-21T13:00:00Z', status: 'complete', orderTotal: null },
			{ _createdAt: '2026-08-21T14:00:00Z', status: 'complete', orderTotal: 50 },
		])
		const counts = await countOrders(
			client,
			orderQueryOptions({ documentType: 'order', totalField: 'total' }, base),
		)
		// Three orders counted, one usable total. A string total must not become NaN and poison the sum.
		expect(counts.total).toBe(3)
		expect(counts.revenue).toBe(50)
	})

	it('counts distinct orders per typeface, not line references', async () => {
		// A three-family order used to add 3 here while adding 1 to the range total, so summing the
		// Bought column and comparing it against Orders did not reconcile and nothing explained why.
		const client = ordersClient([
			{
				_createdAt: '2026-08-21T12:00:00Z',
				status: 'complete',
				typefaces: [{ title: 'Omnes' }, { title: 'Freight' }, { title: 'Omnes' }],
			},
		])

		const counts = await countOrdersByTypeface(
			client,
			orderQueryOptions({ documentType: 'order' }, base),
			'typefaces',
		)

		// Omnes appears twice on the one order and is still one order for Omnes.
		expect(counts?.byTypeface).toEqual({ Omnes: 1, Freight: 1 })
		expect(counts?.orders).toBe(1)
	})

	it('apportions an order total evenly across the families on it', async () => {
		const client = ordersClient([
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete', orderTotal: 300, typefaces: [{ title: 'A' }, { title: 'B' }] },
		])

		const counts = await countOrdersByTypeface(
			client,
			orderQueryOptions({ documentType: 'order', totalField: 'total' }, base),
			'typefaces',
		)

		// Attributing the full 300 to each would double-count a two-family order.
		expect(counts?.revenueByTypeface).toEqual({ A: 150, B: 150 })
	})

	it('returns null rather than an empty result when orders do not resolve to typefaces', async () => {
		const client = ordersClient([])
		expect(await countOrdersByTypeface(client, orderQueryOptions({ documentType: 'order' }, base), null)).toBeNull()
	})
})

describe('hostname scoping', () => {
	it('ANDs the hostname filter into every report a client runs', async () => {
		// Applied at the client rather than per call site on purpose: a filter each report has to
		// remember is a filter some report will forget, and forgetting it does not fail — it adds
		// two businesses together and calls the total one site.
		const filter = hostnameFilter(['www.dardenstudio.com'])
		expect(filter).toEqual({
			filter: { fieldName: 'hostName', inListFilter: { values: ['www.dardenstudio.com'] } },
		})
	})

	it('combines filters without wrapping a single one in a redundant group', () => {
		const a = { filter: { fieldName: 'eventName' } }
		expect(andFilters(a, undefined)).toBe(a)
		expect(andFilters(undefined, undefined)).toBeUndefined()
		expect(andFilters(a, { filter: { fieldName: 'hostName' } })).toEqual({
			andGroup: { expressions: [a, { filter: { fieldName: 'hostName' } }] },
		})
	})
})

describe('journey outcomes', () => {
	it('reports enquiries and subscribes beside the funnel, not inside it', async () => {
		// An enquiry is an alternative ending, not a later stage: slotting it into the sequence
		// would imply a visitor passes through it on the way to a purchase. Before this, a visitor
		// who read three typeface pages and emailed was scored as a drop-off.
		const config = siteConfig({
			eventNames: { enquiry: ['enquiry_submit'], subscribe: ['subscribe'] },
			eventCutovers: { ...siteConfig().eventCutovers, enquiry_submit: PREEXISTING, subscribe: PREEXISTING },
		})
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(12)) })

		const result = await journey(config, ga4, range, [])

		expect(result.outcomes.map((o) => o.key)).toEqual(['enquiry', 'subscribe'])
		expect(result.outcomes[0]?.count).toEqual({ status: 'ok', value: 12 })
	})

	it('reports an uninstrumented outcome as unavailable, never as zero', async () => {
		const config = siteConfig({ eventNames: { enquiry: ['enquiry_submit'] } })
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(12)) })

		const result = await journey(config, ga4, range, [])

		expect(result.outcomes[0]?.count.status).toBe('unavailable')
	})

	it('lists no outcomes on a site that names none', async () => {
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(1)) })
		expect((await journey(siteConfig(), ga4, range, [])).outcomes).toEqual([])
	})
})

describe('typeface interest completeness', () => {
	it('reports a family missing from a truncated result as unknown, not as zero', async () => {
		// The one place this codebase broke its own rule. A family past GA4's 100-row cap rendered
		// as "Viewed 0, Bought 2", which reads as a family that sold without ever being seen.
		const ga4 = createFakeGa4Client({
			single: () => ({
				...makeGa4Report([{ dimensions: ['Omnes'], metrics: [400] }]),
				rowCount: 250,
			}),
		})
		const sanity = createFakeSanityClient(() => [
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete', typefaces: [{ title: 'Quiet Family' }] },
		])

		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity, notices: [] })
		const quiet = data.rows.find((row) => row.typeface === 'Quiet Family')

		expect(quiet?.viewed.status).toBe('unavailable')
		expect(data.rowsTruncated).toBe(true)
	})

	it('reports a genuine zero when GA4 returned a complete result', async () => {
		const ga4 = createFakeGa4Client({
			single: () => makeGa4Report([{ dimensions: ['Omnes'], metrics: [400] }]),
		})
		const sanity = createFakeSanityClient(() => [
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete', typefaces: [{ title: 'Quiet Family' }] },
		])

		const data = await typefaceInterest({ config: siteConfig(), range, ga4, sanity, notices: [] })
		const quiet = data.rows.find((row) => row.typeface === 'Quiet Family')

		// Nothing was withheld or truncated, so absence here really does mean nobody viewed it.
		expect(quiet?.viewed).toEqual({ status: 'ok', value: 0 })
	})
})

describe('minor units and missing totals', () => {
	function ordersClient(docs: unknown[]) {
		return { async fetch<T>(): Promise<T> { return docs as T } }
	}
	const base = { start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' }

	it('converts minor units to major units', async () => {
		// Darden stores amountCharged as the Stripe capture in integer cents, because that is the
		// one figure that reconciles against Stripe. Read as dollars it would be 100x too large.
		const counts = await countOrders(
			ordersClient([{ _createdAt: '2026-08-21T12:00:00Z', status: 'verified', orderTotal: 12000 }]),
			orderQueryOptions({ documentType: 'order', totalField: 'amountCharged', totalInMinorUnits: true }, base),
		)
		expect(counts.revenue).toBe(120)
	})

	it('leaves major units alone', async () => {
		const counts = await countOrders(
			ordersClient([{ _createdAt: '2026-08-21T12:00:00Z', status: 'verified', orderTotal: 120 }]),
			orderQueryOptions({ documentType: 'order', totalField: 'total' }, base),
		)
		expect(counts.revenue).toBe(120)
	})

	it('counts orders whose total is missing, so revenue coverage can be stated', async () => {
		// amountCharged is blank where nothing was captured or the order predates the field, so
		// revenue can silently cover fewer orders than the count above it.
		const counts = await countOrders(
			ordersClient([
				{ _createdAt: '2026-08-21T12:00:00Z', status: 'verified', orderTotal: 4000 },
				{ _createdAt: '2026-08-21T13:00:00Z', status: 'verified' },
			]),
			orderQueryOptions({ documentType: 'order', totalField: 'amountCharged', totalInMinorUnits: true }, base),
		)
		expect(counts.total).toBe(2)
		expect(counts.revenue).toBe(40)
		expect(counts.ordersMissingTotal).toBe(1)
	})

	it('reports no missing totals when the site tracks no revenue at all', async () => {
		const counts = await countOrders(
			ordersClient([{ _createdAt: '2026-08-21T12:00:00Z', status: 'verified' }]),
			orderQueryOptions({ documentType: 'order' }, base),
		)
		expect(counts.ordersMissingTotal).toBe(0)
	})
})

/**
 * Client-level tests that assert the OUTGOING REQUEST, not a helper's return value.
 *
 * The previous hostname test asserted only that `hostnameFilter()` built the right object literal.
 * Deleting the client's `narrow()` — the code that actually applies it — left all tests green,
 * while the tool silently added two businesses together and called the total one site.
 */
describe('what the GA4 client actually sends', () => {
	/** Capture every request body the client posts, with a stubbed token and fetch. */
	async function captureRequests(
		hostnames: readonly string[] | undefined,
		run: (client: ReturnType<typeof createGa4Client>) => Promise<unknown>,
	) {
		const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
		const realFetch = globalThis.fetch

		globalThis.fetch = (async (url: string, init: { body: string }) => ({
			ok: true,
			async json() {
				bodies.push({
					path: String(url).split(':').pop() as string,
					body: JSON.parse(init.body) as Record<string, unknown>,
				})
				return { reports: [{}, {}, {}, {}, {}, {}], funnelTable: {} }
			},
		})) as unknown as typeof fetch

		try {
			await run(createGa4Client('123', { client_email: 'x', private_key: 'y' } as never, { hostnames }))
		} finally {
			globalThis.fetch = realFetch
		}
		return bodies
	}

	it('ANDs the hostname filter into a report that already has its own filter', async () => {
		const bodies = await captureRequests(['www.dardenstudio.com'], (client) =>
			client.runReport({
				metrics: [{ name: 'sessions' }],
				dateRanges: [{ startDate: '2026-08-20', endDate: '2026-08-26' }],
				dimensionFilter: eventNameFilter('page_view'),
			}),
		)

		expect(bodies[0]?.body.dimensionFilter).toEqual({
			andGroup: {
				expressions: [
					{ filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'page_view' } } },
					{ filter: { fieldName: 'hostName', inListFilter: { values: ['www.dardenstudio.com'] } } },
				],
			},
		})
	})

	it('applies the hostname filter to a report with no filter of its own', async () => {
		const bodies = await captureRequests(['www.dardenstudio.com'], (client) =>
			client.runReport({ metrics: [{ name: 'sessions' }], dateRanges: [{ startDate: 'a', endDate: 'b' }] }),
		)
		expect(bodies[0]?.body.dimensionFilter).toEqual({
			filter: { fieldName: 'hostName', inListFilter: { values: ['www.dardenstudio.com'] } },
		})
	})

	it('sends no dimensionFilter at all when no hostnames are configured', async () => {
		const bodies = await captureRequests(undefined, (client) =>
			client.runReport({ metrics: [{ name: 'sessions' }], dateRanges: [{ startDate: 'a', endDate: 'b' }] }),
		)
		expect(bodies[0]?.body.dimensionFilter).toBeUndefined()
	})

	it('applies the hostname filter to every request in a batch', async () => {
		const bodies = await captureRequests(['h.example'], (client) =>
			client.batchRunReports([
				{ metrics: [{ name: 'sessions' }], dateRanges: [{ startDate: 'a', endDate: 'b' }] },
				{ metrics: [{ name: 'totalUsers' }], dateRanges: [{ startDate: 'a', endDate: 'b' }] },
			]),
		)
		const requests = (bodies[0]?.body.requests ?? []) as Array<{ dimensionFilter?: unknown }>
		expect(requests).toHaveLength(2)
		for (const request of requests) {
			expect(request.dimensionFilter).toEqual({
				filter: { fieldName: 'hostName', inListFilter: { values: ['h.example'] } },
			})
		}
	})

	it('splits a batch above GA4\'s five-request limit rather than sending a sixth', async () => {
		// GA4 documents "each batch request is allowed up to 5 requests" and answers a sixth with a
		// 400 — which is not a degraded report, it is the whole panel failing. JOURNEY_STEPS has six
		// rungs, so a fully instrumented site sat exactly on that edge.
		const six = Array.from({ length: 6 }, () => ({
			metrics: [{ name: 'totalUsers' }],
			dateRanges: [{ startDate: 'a', endDate: 'b' }],
		}))
		const bodies = await captureRequests(undefined, (client) => client.batchRunReports(six))

		expect(bodies).toHaveLength(2)
		expect((bodies[0]?.body.requests as unknown[]).length).toBe(5)
		expect((bodies[1]?.body.requests as unknown[]).length).toBe(1)
	})

	it('scopes the funnel with a top-level dimensionFilter, never by gating each step', async () => {
		// A step's filterExpression is the condition a user must meet to be INCLUDED IN THAT STEP,
		// and this funnel is closed — so ANDing the host into every step drops anyone whose first
		// page_view landed on another host, whatever they did afterwards. That is a different
		// number from scoping the report.
		const bodies = await captureRequests(['h.example'], (client) =>
			client.runFunnelReport(
				[{ name: 'Landed', eventNames: ['page_view'] }, { name: 'Tested', eventNames: ['a', 'b'] }],
				{ startDate: '2026-08-20', endDate: '2026-08-26' },
			),
		)

		const body = bodies[0]?.body as { dimensionFilter?: unknown; funnel: { steps: Array<{ filterExpression: unknown }> } }
		expect(body.dimensionFilter).toEqual({
			filter: { fieldName: 'hostName', inListFilter: { values: ['h.example'] } },
		})
		// Single-event steps stay a bare funnelEventFilter; multi-event steps stay an orGroup.
		expect(body.funnel.steps[0]?.filterExpression).toEqual({ funnelEventFilter: { eventName: 'page_view' } })
		expect(body.funnel.steps[1]?.filterExpression).toEqual({
			orGroup: {
				expressions: [
					{ funnelEventFilter: { eventName: 'a' } },
					{ funnelEventFilter: { eventName: 'b' } },
				],
			},
		})
		// And no step carries a host gate.
		expect(JSON.stringify(body.funnel)).not.toContain('funnelFieldFilter')
	})
})

describe('the comparison window', () => {
	function recorder() {
		const sent: { status?: number; body?: unknown } = {}
		const res = {
			setHeader: () => {},
			status(code: number) { sent.status = code; return res },
			json(body: unknown) { sent.body = body },
			end() {},
		}
		return { sent, res }
	}

	/** A handler wired to fakes, with auth stubbed by accepting the gate and failing later. */
	function callFor(report: string, ga4: ReturnType<typeof createFakeGa4Client>) {
		const handler = createVisitorInsightsHandler({
			config: siteConfig(),
			sanityProjectId: 'p1',
			cacheTtlMs: 0,
		})
		const { sent, res } = recorder()
		return { handler, sent, res, ga4, report }
	}

	it('asks for the immediately preceding window of the same length', () => {
		// The arithmetic the whole feature rests on: no overlap, no gap.
		const current = { key: 'week' as const, start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' }
		expect(previousRange(current)).toEqual({
			key: 'week',
			start: '2026-08-13',
			end: '2026-08-19',
			timezone: 'UTC',
		})
	})

	it('runs a second window only for the reports that draw a delta', async () => {
		// Journey is the most expensive report in the package and draws no delta. Running it twice
		// doubled the concurrent load against a property capped at ten and discarded the result.
		expect(COMPARED_REPORTS).toEqual(['acquisition', 'measurement-health'])
		expect(COMPARED_REPORTS).not.toContain('journey')
		expect(COMPARED_REPORTS).not.toContain('typeface-interest')
		expect(COMPARED_REPORTS).not.toContain('diagnostics')
	})

	void callFor
})

describe('typeface interest completeness is per query', () => {
	it('does not let a truncated tester query mark viewed counts unknown', async () => {
		// One shared mutable flag meant truncation in any single tester query flipped EVERY family's
		// viewed column to unknown — and both ratio columns null with it, since each needs a usable
		// viewed value. On TDF that was five independent chances to poison the viewed column.
		const config = siteConfig({ eventNames: { tester: ['tester_engaged'] } })
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map((request) => {
				const filter = request.dimensionFilter as { filter?: { stringFilter?: { value?: string } } }
				const event = filter?.filter?.stringFilter?.value
				// view_item is complete; the tester query is truncated.
				if (event === 'view_item') return makeGa4Report([{ dimensions: ['Omnes'], metrics: [400] }])
				return { ...makeGa4Report([{ dimensions: ['Omnes'], metrics: [10] }]), rowCount: 250 }
			}),
		})
		const sanity = createFakeSanityClient(() => [
			{ _createdAt: '2026-08-21T12:00:00Z', status: 'complete', typefaces: [{ title: 'Quiet Family' }] },
		])

		const data = await typefaceInterest({ config, range, ga4, sanity, notices: [] })
		const quiet = data.rows.find((row) => row.typeface === 'Quiet Family')

		// view_item was complete, so a family absent from it really did have no viewers.
		expect(quiet?.viewed).toEqual({ status: 'ok', value: 0 })
		// The tester query was not, so its absence is unknown.
		expect(quiet?.tested.status).toBe('unavailable')
	})

	it('issues one batch rather than a call per tester event', async () => {
		// TDF names five tester events. Six concurrent requests for this window, twelve once the
		// comparison window existed, against a property whose concurrency ceiling is ten.
		const config = siteConfig({
			eventNames: { tester: ['a', 'b', 'c', 'd', 'e'] },
			eventCutovers: { ...siteConfig().eventCutovers, a: PREEXISTING, b: PREEXISTING, c: PREEXISTING, d: PREEXISTING, e: PREEXISTING },
		})
		const ga4 = createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(1)) })

		await typefaceInterest({ config, range, ga4, sanity: null, notices: [] })

		expect(ga4.batchCalls).toHaveLength(1)
		expect(ga4.singleCalls).toHaveLength(0)
		// view_item plus five tester events.
		expect(ga4.batchCalls[0]).toHaveLength(6)
	})

	it('applies partial coverage rather than dividing a full range of orders by a partial one', async () => {
		// Darden's view_item cutover was three days before a Quarter range was first read, so the
		// panel divided 91 days of Sanity orders by 3 days of GA4 viewers — and buyRate clamped the
		// resulting impossibility to a plausible-looking 100%.
		const config = siteConfig({
			eventCutovers: { ...siteConfig().eventCutovers, view_item: '2026-08-25' },
		})
		const ga4 = createFakeGa4Client({
			batch: (requests) => requests.map(() => makeGa4Report([{ dimensions: ['Omnes'], metrics: [40] }])),
		})

		const data = await typefaceInterest({ config, range, ga4, sanity: null, notices: [] })
		const omnes = data.rows.find((row) => row.typeface === 'Omnes')

		// Partial, carrying its number and the date it is valid from — not a bare ok().
		expect(omnes?.viewed.status).toBe('partial')
	})
})

describe('Mailchimp', () => {
	it('derives the datacenter from the key rather than asking for it separately', () => {
		// The host is https://us14.api.mailchimp.com. Deriving it means the two can never disagree,
		// and a key rotated into another datacenter keeps working without a second edit.
		expect(datacenterFromKey('abc123def456-us14')).toBe('us14')
		expect(datacenterFromKey('abc123def456-us21')).toBe('us21')
	})

	it('refuses a key with no datacenter suffix rather than building a broken host', () => {
		// An OAuth token carries none. Without this it fails per request as an unresolvable
		// hostname, which names neither the cause nor the fix.
		expect(datacenterFromKey('an-oauth-token')).toBeNull()
		expect(datacenterFromKey('nodashes')).toBeNull()
		expect(createMailchimpClient('an-oauth-token', 'list1')).toBeNull()
	})

	it('reports the list count, which replaces the site’s own subscribe event', async () => {
		// Darden's subscribe event fires twice per signup and treats HTTP 400 — an address already
		// on the list — as a success. This is the number it was approximating badly.
		const data = await measurementHealth({
			config: siteConfig({ mailchimp: { enabled: true } }),
			range,
			ga4: createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) }),
			vercel: null,
			sanity: null,
			mailchimp: createFakeMailchimpClient({ members: 4210, membersAtStart: 4102 }),
		})

		expect(data.audience).toEqual({ status: 'ok', value: 4210 })
		expect(data.audienceGrowth).toEqual({ status: 'ok', value: 108 })
	})

	it('withholds growth rather than approximating it when the range is not a whole month', async () => {
		// Mailchimp reports growth by calendar month. A growth figure measured over a different
		// window than the panel claims is worse than none.
		const data = await measurementHealth({
			config: siteConfig({ mailchimp: { enabled: true } }),
			range,
			ga4: createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) }),
			vercel: null,
			sanity: null,
			mailchimp: createFakeMailchimpClient({ members: 4210, membersAtStart: null }),
		})

		expect(data.audienceGrowth.status).toBe('unavailable')
		expect(data.audience.status).toBe('ok')
	})

	it('degrades to unavailable when Mailchimp fails, without failing the panel', async () => {
		const data = await measurementHealth({
			config: siteConfig({ mailchimp: { enabled: true } }),
			range,
			ga4: createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) }),
			vercel: null,
			sanity: null,
			mailchimp: createFakeMailchimpClient({ members: 0, membersAtStart: null }, new Error('429')),
		})

		expect(data.audience.status).toBe('unavailable')
		// The rest of the panel still answered.
		expect(data.ga4Pageviews.status).toBe('ok')
	})

	it('reports no audience at all on a site without Mailchimp', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({ batch: (requests) => requests.map(() => makeGa4Total(10)) }),
			vercel: null,
			sanity: null,
		})

		expect(data.audience.status).toBe('unavailable')
		expect(data.campaigns).toEqual([])
	})
})

describe('the shortfall compares like days with like', () => {
	const week: DateRange = { key: 'week', start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' }

	/** A GA4 daily report over the given date->pageviews map, in GA4's own YYYYMMDD form. */
	const ga4Daily = (byDate: Record<string, number>) =>
		makeGa4Report(Object.entries(byDate).map(([date, value]) => ({
			dimensions: [date.replace(/-/g, '')],
			metrics: [value],
		})))

	it('ignores a day one source reported and the other did not', async () => {
		// The two sides were filtered independently and their totals differenced regardless of
		// whether they covered the same days — and vercelIsDaily tolerates 30% of days missing, so
		// nearly a third of a range could be present on one side only. Every such day counted as a
		// shortfall that was really an absence.
		const data = await measurementHealth({
			config: siteConfig(),
			range: week,
			now: new Date('2026-08-27T12:00:00Z'),
			ga4: createFakeGa4Client({
				batch: () => [
					makeGa4Total(400),
					makeGa4Report([{ metrics: [400, 320] }]),
					makeGa4Total(0),
					// GA4 covers the whole week.
					ga4Daily({
						'2026-08-20': 80, '2026-08-21': 80, '2026-08-22': 80,
						'2026-08-23': 80, '2026-08-24': 80, '2026-08-25': 80,
					}),
				],
			}),
			// Vercel is missing the 25th entirely — but still covers enough of the week to count as
			// a daily series, which is exactly the state that made this bug reachable.
			vercel: createFakeVercelClient(makeVercelPageviews({
				'2026-08-20': 100, '2026-08-21': 100, '2026-08-22': 100,
				'2026-08-23': 100, '2026-08-24': 100,
			})),
			sanity: null,
		})

		// Five shared days — the 20th to the 24th. GA4's 25th is dropped because Vercel never
		// reported it, and the 26th because it is still settling. 400 GA4 against 500 Vercel is the
		// fifth that is genuinely missing; including GA4's unmatched day against a Vercel total that
		// never contained it produced 0.0, i.e. perfect agreement, from an absence.
		expect(data.shortfallRatio).toBeCloseTo(0.2, 2)
	})
})

describe('an unreadable order book is stated, not absorbed', () => {
	const week: DateRange = { key: 'week', start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' }

	it('does not draw a confident zero-order line when Sanity failed', async () => {
		// `orders: ordersByDate[date] ?? 0` was justified by Sanity being exact — true when it
		// answers. When the query threw, every calendar day got a zero and the chart drew a flat
		// no-sales line while the headline order figure showed unavailable beside it.
		const data = await measurementHealth({
			config: siteConfig(),
			range: week,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(400), makeGa4Report([{ metrics: [400, 320] }]), makeGa4Total(0)] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: { fetch: () => Promise.reject(new Error('Sanity down')) } as never,
		})

		expect(data.orders.status).toBe('unavailable')
		for (const day of data.crossSource) {
			expect(day.orders, `${day.date} must not read as a measured zero`).toBeNull()
		}
	})

	it('still reports zeros as zeros when Sanity answered', async () => {
		const data = await measurementHealth({
			config: siteConfig(),
			range: week,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(400), makeGa4Report([{ metrics: [400, 320] }]), makeGa4Total(0)] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: createFakeSanityClient(() => makeOrders(['2026-08-21'])),
		})

		const empty = data.crossSource.filter((d) => d.orders === 0)
		expect(empty.length).toBeGreaterThan(0)
	})
})

describe('bounded requests and aligned batches', () => {
	it('gives up on a hung upstream rather than holding the panel', async () => {
		// No client had a timeout, so a hung connection held the whole panel until the platform's
		// function limit — and because the report layer fans out with Promise.all, the slowest of up
		// to fourteen calls set the floor for all of them. The reader saw a spinner, not an error.
		const original = globalThis.fetch
		globalThis.fetch = ((_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
		})) as typeof fetch

		try {
			await expect(fetchWithTimeout('https://example.test/hang', {}, 20))
				.rejects.toThrow(/timed out/)
		} finally {
			globalThis.fetch = original
		}
	})

	it('honours a caller signal without swallowing it as a timeout', async () => {
		// Adding a timeout must not stop a caller's own cancellation working, and an abort the caller
		// asked for should not be reported as the upstream being slow.
		const original = globalThis.fetch
		globalThis.fetch = ((_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
		})) as typeof fetch

		const caller = new AbortController()
		try {
			const pending = fetchWithTimeout('https://example.test/hang', { signal: caller.signal }, 5_000)
			caller.abort()
			await expect(pending).rejects.toThrow(/aborted/)
		} finally {
			globalThis.fetch = original
		}
	})

	it('refuses a chunk GA4 did not answer in full', () => {
		// Padding a short chunk at its tail only prevented slippage BETWEEN chunks; a missing middle
		// entry still shifted every later result within its own, and GA4's batch response carries no
		// per-request identifier, so the mapping cannot be repaired. The placeholder was also read as
		// a measured zero — which became a 0% capture rate and an instruction to go and investigate a
		// perfectly healthy purchase tag. A fabricated diagnosis is worse than a missing figure.
		const report = (rows: number): Ga4Report => ({
			rows: Array.from({ length: rows }, () => ({ dimensions: [], metrics: [1] })),
			thresholded: false, sampled: false, rowCount: rows,
		})

		expect(() => alignBatch([{ reports: [report(1), report(2)], expected: 5 }]))
			.toThrow(/cannot be matched to requests/)
	})

	it('passes a complete batch through in request order', () => {
		const report = (rows: number): Ga4Report => ({
			rows: Array.from({ length: rows }, () => ({ dimensions: [], metrics: [1] })),
			thresholded: false, sampled: false, rowCount: rows,
		})
		expect(alignBatch([
			{ reports: [report(1), report(2)], expected: 2 },
			{ reports: [report(9)], expected: 1 },
		]).map((r) => r.rowCount)).toEqual([1, 2, 9])
	})

	it('takes the mapped prefix when a chunk answers with more than it was asked', () => {
		// Surprising rather than dangerous: responses are in request order, so the first `expected`
		// map correctly. Throwing here would break on a stub that over-answers and buy nothing.
		const report = (rows: number): Ga4Report => ({
			rows: Array.from({ length: rows }, () => ({ dimensions: [], metrics: [1] })),
			thresholded: false, sampled: false, rowCount: rows,
		})
		expect(alignBatch([{ reports: [report(1), report(2), report(3)], expected: 2 }])
			.map((r) => r.rowCount)).toEqual([1, 2])
	})

})

describe('order queries count published documents only', () => {
	it('excludes drafts from every order query', async () => {
		// @sanity/client v6 defaults to the `raw` perspective for a token-authenticated request, and
		// the sites pass a token — so an order anyone has opened and edited in the Studio comes back
		// twice, as `orderId` and as `drafts.orderId`. That double-counts it in the total, in the
		// revenue and in its day's stem, in the one figure this tool calls exact and calibrates the
		// capture model against.
		const queries: string[] = []
		const client = {
			fetch: (query: string) => {
				queries.push(query)
				return Promise.resolve([])
			},
		} as never

		const options = orderQueryOptions(
			{ documentType: 'order', statusField: 'orderStatus.status', countedStatuses: ['verified'] },
			{ start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' },
		)

		await countOrders(client, options)
		await countOrdersByTypeface(client, options, 'typefaces')
		await countLicenceTiers(client, options, 'typefaces', { licenseDesktop: 'Desktop' })

		expect(queries.length).toBe(3)
		for (const query of queries) {
			expect(query, query).toContain('!(_id in path("drafts.**"))')
		}
	})
})

describe('Vercel buckets are labelled by the day they mostly cover', () => {
	it('keeps the UTC date rather than the local day the bucket began on', () => {
		// A release converted the bucket's start instant into the property timezone, reasoning that
		// every other source is anchored there. Vercel buckets by UTC DAY, so that names the local
		// day the bucket BEGAN on — and for any zone behind UTC that is the minority of it. A Los
		// Angeles bucket spans 7 hours of one local day and 17 of the next, and the conversion
		// picked the 7. The UTC date is the majority day for every zone within 12 hours of UTC.
		const bucketStart = '2026-09-05T00:00:00Z'
		expect(bucketStart.slice(0, 10)).toBe('2026-09-05')
		// What the conversion produced, for the record: the wrong day for the Americas.
		expect(formatInTimeZone(new Date(bucketStart), 'America/Los_Angeles')).toBe('2026-09-04')
	})
})

describe('an order window is half-open, so no order lands in two ranges', () => {
	it('excludes the end instant rather than including it', async () => {
		// `_createdAt < $end` with $end being the START of the day after — so day N's window ends
		// exactly where day N+1's begins. Making it `<=` would count an order placed at that instant
		// in both the current window and the next, in the figure the tool calls exact.
		const queries: string[] = []
		const client = {
			fetch: (query: string) => { queries.push(query); return Promise.resolve([]) },
		} as never

		await countOrders(client, orderQueryOptions(
			{ documentType: 'order', statusField: 'orderStatus.status', countedStatuses: ['verified'] },
			{ start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' },
		))

		expect(queries[0]).toContain('_createdAt >= $start')
		expect(queries[0]).toContain('_createdAt < $end')
		expect(queries[0]).not.toContain('_createdAt <= $end')
	})

	it('ends the window at the start of the day after the last one', async () => {
		// The bound has to be exclusive AND cover the whole final day; an exclusive bound at the
		// final day's own start would silently drop every order placed on it. Asserted through the
		// params the query is actually run with, rather than by widening the module's exports.
		let params: Record<string, unknown> | undefined
		const client = {
			fetch: (_query: string, p: Record<string, unknown>) => { params = p; return Promise.resolve([]) },
		} as never

		await countOrders(client, orderQueryOptions(
			{ documentType: 'order', statusField: 'orderStatus.status', countedStatuses: ['verified'] },
			{ start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' },
		))

		expect(params?.start).toBe('2026-08-20T00:00:00.000Z')
		expect(params?.end).toBe('2026-08-27T00:00:00.000Z')
	})

})

describe('the funnel reads GA4 completion rates in the direction GA4 means them', () => {
	/** A closed funnel, with GA4's own forward-looking rates and abandonments. */
	const funnelRows = (counts: number[]) => counts.map((activeUsers, i) => {
		const next = counts[i + 1]
		const abandonments = next === undefined ? activeUsers : activeUsers - next
		return {
			name: ['Landed', 'Viewed a typeface', 'Used the type tester', 'Added to cart', 'Began checkout', 'Purchased'][i]!,
			activeUsers,
			// GA4's documented arithmetic: the complement of abandonments over THIS step's users.
			completionRate: activeUsers > 0 ? 1 - abandonments / activeUsers : 0,
			abandonments,
		}
	})

	it('reports each rung against the step before it, not against itself', async () => {
		// Reading `row.completionRate` as this step's inbound conversion shifted every rate one rung
		// forward, and gave the last rung 0% — the final step has no next step, so its own completion
		// rate is zero, printed beside a count of real purchasers.
		const data = await journey(
			siteConfig(),
			createFakeGa4Client({ funnel: () => ({ steps: funnelRows([1000, 500, 250, 100, 60, 50]), sampled: false }) }),
			range,
			[],
		)

		expect(data.measurement).toBe('sequence')
		const rate = (label: string) => data.steps.find((s) => s.label === label)?.conversionFromPrevious
		expect(rate('Used the type tester')).toBeCloseTo(0.5, 6)
		expect(rate('Added to cart')).toBeCloseTo(0.4, 6)
		expect(rate('Began checkout')).toBeCloseTo(0.6, 6)
		// The rung that used to read 0%.
		expect(rate('Purchased')).toBeCloseTo(50 / 60, 6)
	})

	it('leaves the entry step without an inbound rate', async () => {
		const data = await journey(
			siteConfig(),
			createFakeGa4Client({ funnel: () => ({ steps: funnelRows([1000, 500, 250]), sampled: false }) }),
			range,
			[],
		)
		expect(data.steps[0]?.conversionFromPrevious).toBeNull()
	})
})

describe('a family whose orders carry no total is not shown as zero revenue', () => {
	it('reads as unavailable rather than $0.00', async () => {
		// orders.ts deliberately writes no entry for such a family, saying in a comment that it must
		// read as unavailable and not as $0.00 — the same defect as rendering a withheld view count as
		// zero. `?? 0` undid that: one sale with a missing amount printed "$0.00" beside "1", with a
		// buy rate computed as normal.
		const data = await typefaceInterest({
			config: siteConfig({ orders: {
				documentType: 'order', statusField: 'orderStatus.status', countedStatuses: ['verified'],
				typefacesField: 'typefaces', totalField: 'amountCharged',
			} }),
			range,
			ga4: createFakeGa4Client({
				single: () => makeGa4Report([{ dimensions: ['Freight'], metrics: [400] }]),
			}),
			// One order for Freight, and a revenue map that has no entry for it.
			sanity: { fetch: () => Promise.resolve([
				{ _createdAt: '2026-08-21T10:00:00Z', typefaces: [{ name: 'Freight' }] },
			]) } as never,
		})

		const freight = data.rows.find((r) => r.typeface === 'Freight')
		expect(freight?.bought.status).toBe('ok')
		expect(freight?.revenue.status).toBe('unavailable')
		if (freight?.revenue.status === 'unavailable') {
			expect(freight.revenue.reason).not.toBe('not_applicable')
		}
	})
})

describe('a multi-family order splits its total rather than counting it whole', () => {
	it('apportions revenue across the families on the order', () => {
		// `value / keys.length`. Counting the whole order total against every family it covers would
		// report a foundry-wide licence three times over, and the per-family ranking — which is what a
		// pricing decision reads — would be built from a revenue figure larger than the takings.
		let captured: Record<string, unknown> | undefined
		const client = {
			fetch: (_q: string, p: Record<string, unknown>) => { captured = p; return Promise.resolve([
				{ _createdAt: '2026-08-21T10:00:00Z', status: 'verified', orderTotal: 900, typefaces: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] },
			]) },
		} as never

		return countOrdersByTypeface(
			client,
			orderQueryOptions({
				documentType: 'order', statusField: 'orderStatus.status', countedStatuses: ['verified'],
				totalField: 'orderTotal',
			}, range),
			'typefaces',
		).then((counts) => {
			expect(captured).toBeDefined()
			expect(counts?.byTypeface).toEqual({ A: 1, B: 1, C: 1 })
			// 900 split three ways, not 900 against each.
			expect(counts?.revenueByTypeface?.A).toBeCloseTo(300, 6)
			const total = Object.values(counts?.revenueByTypeface ?? {}).reduce((s, v) => s + v, 0)
			expect(total).toBeCloseTo(900, 6)
		})
	})
})

describe('behaviours whose comments explain them but whose tests did not', () => {
	it('takes the largest consent row, never their sum', async () => {
		// Distinct-user counts across several event rows overlap: anyone who fired two of them is in
		// both. Summing would exceed the true union and can exceed the user count entirely, which
		// then trips the "grants exceed users" error on healthy data. The existing test used one row,
		// so max and sum were indistinguishable.
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			ga4: createFakeGa4Client({
				batch: () => [
					makeGa4Total(400),
					makeGa4Report([{ metrics: [400, 320] }]),
					// Three consent event rows, overlapping: 240 is the tightest correct lower bound.
					makeGa4Report([{ metrics: [240] }, { metrics: [180] }, { metrics: [120] }]),
				],
			}),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: null,
		})

		// 240 of 320 users = 75%. The sum, 540, would exceed 320 and report a source error.
		expect(data.consentRate).toEqual({ status: 'ok', value: 75 })
	})

	it('withholds the settled shortfall when too few days can be compared', async () => {
		// A ratio built from one or two shared days is noise wearing a decimal point; the whole-range
		// totals at least cover one consistent window each.
		const data = await measurementHealth({
			config: siteConfig(),
			range,
			now: new Date('2026-08-26T12:00:00Z'),
			ga4: createFakeGa4Client({
				batch: () => [
					makeGa4Total(400),
					makeGa4Report([{ metrics: [400, 320] }]),
					makeGa4Total(0),
					makeGa4Report([{ dimensions: ['20260820'], metrics: [80] }, { dimensions: ['20260821'], metrics: [80] }]),
				],
			}),
			// Vercel covers enough of the week to count as a daily series — which is what makes this
			// reachable — but GA4 reported only two of those days, so just two can be compared.
			vercel: createFakeVercelClient(makeVercelPageviews({
				'2026-08-20': 100, '2026-08-21': 100, '2026-08-22': 100,
				'2026-08-23': 100, '2026-08-24': 100, '2026-08-25': 100,
			})),
			sanity: null,
		})

		// Two shared days would give (200-160)/200 = 0.2. Below the floor it falls back to the
		// whole-range totals instead, which at least cover one consistent window each.
		expect(data.shortfallRatio).not.toBeCloseTo(0.2, 5)
	})
})

describe('an absent GA4 total is absent, not zero', () => {
	it('leaves metricTotal undefined when the response carried none', async () => {
		// toMetricNumber yields NaN for an absent value. Letting that through would put NaN into a
		// share — a silent wrong answer — while `undefined` means "not requested" and every caller
		// already withholds the share rather than dividing by a subtotal.
		const bodies: unknown[] = []
		globalThis.fetch = (async () => ({
			ok: true, status: 200,
			async json() {
				bodies.push(1)
				// A response with rows but no totals block at all.
				return { rows: [{ dimensionValues: [{ value: 'x' }], metricValues: [{ value: '5' }] }] }
			},
		})) as unknown as typeof fetch

		try {
			const client = createGa4Client('1', { client_email: 'x', private_key: 'y' } as never)
			const report = await client.runReport({
				metrics: [{ name: 'sessions' }],
				dateRanges: [{ startDate: '2026-08-20', endDate: '2026-08-26' }],
			})
			expect(report.metricTotal).toBeUndefined()
			expect(Number.isNaN(report.metricTotal as number)).toBe(false)
		} finally {
			bodies.length = 0
		}
	})
})

describe('the revenue split refuses what it cannot check', () => {
	const sourceRow = (source: string, sessions: number) => ({
		dimensions: [source, 'Referral', 'referral', '(not set)'],
		metrics: [sessions, sessions],
	})

	const run = (actuals: { revenue: number | null; orders: number | null } | null, purchases: number) =>
		acquisition({
			config: siteConfig(),
			range,
			actuals,
			ga4: createFakeGa4Client({
				single: (request) => (request.metrics?.some((m) => m.name === 'ecommercePurchases')
					? makeGa4Report([{ dimensions: ['a.test', 'Referral', 'referral', '(not set)'], metrics: [purchases, 1000] }])
					: makeGa4Report([sourceRow('a.test', 300)])),
			}),
			notices: [],
		})

	it('withholds the split when the order book could not be read', async () => {
		// Unknown coverage was treated as PASSING, so an unreadable order book switched off the
		// window that catches over-attribution and the split rendered as sound on a double-firing tag.
		const data = await run(null, 20)
		expect(data.splitIsSound).toBe(false)
		for (const row of data.rows) expect(row.revenueShare ?? null).toBeNull()
	})

	it('withholds it when GA4 attributed more purchases than there are orders', async () => {
		// The upper bound: counting sales that did not happen is a finding, not a shortage.
		const data = await run({ revenue: 5000, orders: 7 }, 20)
		expect(data.splitIsSound).toBe(false)
	})

	it('computes it when coverage sits inside the window', async () => {
		const data = await run({ revenue: 5000, orders: 10 }, 6)
		expect(data.splitIsSound).toBe(true)
	})
})

describe('revenue says when it covers only some of the orders', () => {
	const orders = (withTotal: number, withoutTotal: number) => [
		...Array.from({ length: withTotal }, (_, i) => ({
			_createdAt: `2026-08-2${i % 5}T10:00:00Z`, status: 'verified', orderTotal: 4400,
		})),
		...Array.from({ length: withoutTotal }, (_, i) => ({
			_createdAt: `2026-08-2${i % 5}T11:00:00Z`, status: 'verified', orderTotal: null,
		})),
	]

	it('reports a partial figure when some counted orders carry no amount', async () => {
		// Checked against Darden's live data: 11 of 69 counted orders carry an amount, so the Revenue
		// headline was built from a sixth of them and presented as the period's revenue. The notice
		// saying so is a standing caveat and renders below the panel.
		const data = await measurementHealth({
			config: siteConfig({ orders: {
				documentType: 'order', statusField: 'orderStatus.status',
				countedStatuses: ['verified'], totalField: 'amountCharged', currency: 'USD',
				typefacesField: 'items[].typeface',
			} }),
			range,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(400), makeGa4Report([{ metrics: [400, 320] }]), makeGa4Total(0)] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: { fetch: () => Promise.resolve(orders(11, 58)) } as never,
		})

		expect(data.revenue.status).toBe('partial')
		if (data.revenue.status === 'partial') {
			expect(data.revenue.note).toContain('11 of 69')
		}
	})

	it('reports a plain figure when every counted order carries one', async () => {
		const data = await measurementHealth({
			config: siteConfig({ orders: {
				documentType: 'order', statusField: 'orderStatus.status',
				countedStatuses: ['verified'], totalField: 'amountCharged', currency: 'USD',
				typefacesField: 'items[].typeface',
			} }),
			range,
			ga4: createFakeGa4Client({ batch: () => [makeGa4Total(400), makeGa4Report([{ metrics: [400, 320] }]), makeGa4Total(0)] }),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-20': 1000 })),
			sanity: { fetch: () => Promise.resolve(orders(11, 0)) } as never,
		})

		expect(data.revenue.status).toBe('ok')
	})
})

describe('attributing orders to email sends', () => {
	/** A day in the cross-source series; only orders and revenue matter here. */
	const day = (date: string, orders: number | null, revenue: number | null) => ({
		date, vercelPageviews: null, ga4Pageviews: null, ga4Sessions: null, orders, revenue,
	})

	/** One send, at noon in the property zone so no timezone edge is in play by accident. */
	const send = (title: string, date: string) => ({
		title, subject: title, sentAt: `${date}T19:00:00+00:00`,
		sent: 2000, opens: 900, clicks: 120, unsubscribed: 3,
	})

	const week = [
		day('2026-08-20', 1, 100), day('2026-08-21', 2, 200), day('2026-08-22', 4, 400),
		day('2026-08-23', 8, 800), day('2026-08-24', 16, 1600), day('2026-08-25', 32, 3200),
		day('2026-08-26', 64, 6400),
	]

	it('counts the send day and the two days after it', () => {
		const [campaign] = attributeToSends([send('August', '2026-08-20')], week, 'America/Los_Angeles', '2026-08-26')
		expect(campaign!.ordersAfter).toBe(1 + 2 + 4)
		expect(campaign!.revenueAfter).toBe(700)
		expect(campaign!.windowDays).toBe(3)
		expect(campaign!.windowComplete).toBe(true)
	})

	it('stops a window early when the next send lands inside it', () => {
		// Otherwise two sends three days apart both claim the same orders and the columns sum to more
		// sales than the foundry made.
		const [first, second] = attributeToSends(
			[send('First', '2026-08-20'), send('Second', '2026-08-22')],
			week, 'America/Los_Angeles', '2026-08-26',
		)
		expect(first!.ordersAfter).toBe(1 + 2)
		expect(second!.ordersAfter).toBe(4 + 8 + 16)
		// The partition holds: no order is counted twice.
		expect((first!.ordersAfter ?? 0) + (second!.ordersAfter ?? 0)).toBe(1 + 2 + 4 + 8 + 16)
	})

	it('says a window is incomplete rather than reporting a short one as a poor campaign', () => {
		const [campaign] = attributeToSends([send('Late', '2026-08-26')], week, 'America/Los_Angeles', '2026-08-26')
		expect(campaign!.windowComplete).toBe(false)
		expect(campaign!.windowDays).toBe(1)
		expect(campaign!.ordersAfter).toBe(64)
	})

	it('reports a send from before the range as unmeasured, not as zero orders', () => {
		// A campaign whose days are all outside the window sold an unknown amount. Zero would rank it
		// bottom of the table as the worst performer on the strength of the range the reader chose.
		const [campaign] = attributeToSends([send('Earlier', '2026-08-01')], week, 'America/Los_Angeles', '2026-08-26')
		expect(campaign!.ordersAfter).toBeNull()
		expect(campaign!.revenueAfter).toBeNull()
	})

	it('does not turn a window the order query could not answer for into a measured zero', () => {
		// `orders: null` means Sanity did not answer for that day, which is the shape of a failed
		// order query — every day null. Summed as zeros the campaign reports having sold nothing,
		// which is a statement about the send rather than about the outage that produced it.
		const blind = [day('2026-08-20', null, null), day('2026-08-21', null, null), day('2026-08-22', null, null)]
		const [campaign] = attributeToSends([send('Blind', '2026-08-20')], blind, 'America/Los_Angeles', '2026-08-22')
		expect(campaign!.ordersAfter).toBeNull()
		expect(campaign!.revenueAfter).toBeNull()
		// The window itself was measured — the days are present, their order counts are not.
		expect(campaign!.windowDays).toBe(3)
	})

	it('still totals the days it does have when only some are missing', () => {
		const withHole = [day('2026-08-20', 1, 100), day('2026-08-21', null, null), day('2026-08-22', 4, 400)]
		const [campaign] = attributeToSends([send('Holey', '2026-08-20')], withHole, 'America/Los_Angeles', '2026-08-22')
		expect(campaign!.ordersAfter).toBe(5)
	})

	it('places an evening send on the day it happened where the reader lives', () => {
		// 19:00 UTC is midday in Los Angeles. Read in UTC the send lands on the same day here, but a
		// later send would roll over — orders.ts is zoned for exactly this and the join has to match.
		const evening = { ...send('Evening', '2026-08-22'), sentAt: '2026-08-23T03:00:00+00:00' }
		const [campaign] = attributeToSends([evening], week, 'America/Los_Angeles', '2026-08-26')
		// 2026-08-23T03:00Z is 2026-08-22 20:00 in Los Angeles.
		expect(campaign!.ordersAfter).toBe(4 + 8 + 16)
	})
})
