/**
 * Measurement Health — "what are we missing?", answered honestly.
 *
 * This panel began life as a "coverage gap" that subtracted Vercel pageviews from GA4 sessions and
 * attributed the difference to consent, ad-blockers and bots. That is not a valid subtraction:
 * sessions and pageviews are different units, so the difference is dominated by the unit mismatch
 * rather than by anything missing. Worse, GA4 exposes no signal that separates consent-denied from
 * blocked from bot traffic, so the attribution would have been a guess rendered with the authority
 * of a measurement.
 *
 * What this reports instead:
 *   - GA4 pageviews against Vercel pageviews, the same unit on both sides
 *   - GA4 sessions and orders alongside as context, never subtracted
 *   - one residual, labelled unexplained, with the causes we can actually measure broken out
 *
 * The only cause we can measure is consent: a `consent_granted` event makes the acceptance rate a
 * real number rather than an inference. Until that event is instrumented, the residual stays whole
 * and the panel says why.
 */

import type { MeasurementHealthData, DailyPoint } from '../../reportData'
import type { DateRange, MetricValue } from '../../types'
import { ok, unavailable } from '../../types'
import type { SiteAnalyticsConfig } from '../../core/siteConfig'
import { coverageForAny } from '../../core/cutover'
import { eventNamesFilter, sumFirstMetric, type Ga4Client } from '../ga4'
import type { VercelClient } from '../vercel'
import { countOrders, type SanityQueryClient } from '../orders'

/** Whole days covered by a range, inclusive of both ends. */
function daysInRange(range: DateRange): number {
	const ms = Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)
	return Number.isFinite(ms) ? Math.round(ms / 86400000) + 1 : 0
}

/** The event whose presence turns the consent share from a guess into a measurement. */
const CONSENT_EVENT = 'consent_granted'


/** Inputs for the measurement-health report. */
export interface MeasurementHealthInput {
	config: SiteAnalyticsConfig
	range: DateRange
	ga4: Ga4Client | null
	vercel: VercelClient | null
	sanity: SanityQueryClient | null
	/** Report-level caveats. Sampling is pushed here so the panel shows it without extra plumbing. */
	notices?: string[]
}

/** Build the plain-language reading shown beneath the figures. */
function interpret(ga4Views: MetricValue, vercelViews: MetricValue, shortfall: number | null, consent: MetricValue): string {
	if (ga4Views.status === 'unavailable' && vercelViews.status === 'unavailable') {
		return 'Neither source answered, so nothing can be said about coverage for this range.'
	}
	if (shortfall === null) {
		return 'Only one pageview source answered, so the two cannot be compared for this range.'
	}

	const percent = Math.round(Math.abs(shortfall) * 100)

	if (Math.abs(shortfall) < 0.05) {
		return `GA4 and Vercel agree to within ${percent}% on pageviews. Nothing here suggests a measurement problem.`
	}

	const direction = shortfall > 0 ? 'fewer' : 'more'
	const base = `GA4 recorded ${percent}% ${direction} pageviews than Vercel.`

	// Above this, the gap is larger than consent refusal and ad-blocking can plausibly account for,
	// and the honest reading changes from "some loss is expected" to "something is broken".
	//
	// This exists because of a real failure. Darden's GA4 fell 86% below Vercel overnight on
	// 2026-08-24 and stayed there for over a week while Vercel ran flat. The panel reported the
	// magnitude accurately and framed it, as it framed every other magnitude, as expected loss with
	// an unexplained remainder — so a total measurement outage read as a slightly worse than usual
	// week. A tool called Measurement Health has to be able to say when measurement has failed.
	if (shortfall > 0.6) {
		return `${base} That is far more than consent refusal and ad-blocking can account for — those `
			+ `typically cost tens of percent, not most of the traffic. Treat this as a measurement `
			+ `failure until proven otherwise: check that the tag still fires on a real page load, and `
			+ `whether a GA4 data filter or stream setting changed. The daily series below will show `
			+ `whether the gap opened on a particular day, which distinguishes a break from a drift.`
	}

	if (consent.status === 'unavailable') {
		return `${base} How much of that is consent refusal cannot be measured until the consent_granted event is instrumented, so the difference is currently unexplained rather than attributed.`
	}

	const consentPercent = Math.round((1 - consent.value / 100) * 100)
	return `${base} Around ${consentPercent}% of sessions did not grant analytics consent, which accounts for part of it. The remainder is unexplained — ad-blocking and bot filtering are plausible but are not separately measurable.`
}

/**
 * Run the measurement-health report.
 *
 * Each source is queried independently and a failure in one degrades only its own figures, so the
 * panel can always say which source did not answer rather than showing an unexplained blank.
 */
export async function measurementHealth(input: MeasurementHealthInput): Promise<MeasurementHealthData> {
	const { config, range, ga4, vercel, sanity } = input
	// Consent event names are per-site, like tester events.
	const consentEvents = config.eventNames?.consent ?? [CONSENT_EVENT]

	let ga4Pageviews: MetricValue = unavailable('source_error', 'GA4 not configured')
	let ga4Sessions: MetricValue = unavailable('source_error', 'GA4 not configured')
	let consentRate: MetricValue = unavailable('not_instrumented')
	/** Daily GA4 pageviews keyed by ISO date, for the trend. */
	const ga4ByDate = new Map<string, number>()
	/** Daily Vercel pageviews keyed by ISO date. Already fetched; previously discarded. */
	let vercelByDate: Record<string, number> = {}

	if (ga4) {
		try {
			// One batched call rather than three separate quota-charged requests.
			const [views, sessions, consent, daily] = await ga4.batchRunReports([
				{
					metrics: [{ name: 'screenPageViews' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
				},
				{
					metrics: [{ name: 'sessions' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
				},
				{
					metrics: [{ name: 'eventCount' }],
					dimensions: [{ name: 'eventName' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
					dimensionFilter: eventNamesFilter(consentEvents),
				},
				// The daily series. Same batch, so it costs one row in an existing request rather
				// than another quota-charged call.
				{
					metrics: [{ name: 'screenPageViews' }],
					dimensions: [{ name: 'date' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
					orderBys: [{ dimension: { dimensionName: 'date' } }],
					limit: 400,
				},
			])

			// GA4 returns dates as YYYYMMDD; the Vercel side and the UI both use ISO.
			if (daily) {
				for (const row of daily.rows) {
					const raw = row.dimensions[0]
					const value = row.metrics[0]
					if (!raw || raw.length !== 8 || !Number.isFinite(value)) continue
					ga4ByDate.set(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, value as number)
				}
			}

			if (views) ga4Pageviews = ok(sumFirstMetric(views))
			if (sessions) ga4Sessions = ok(sumFirstMetric(sessions))
			if (views?.sampled || sessions?.sampled) {
				input.notices?.push('GA4 answered from a sample, so its pageview and session figures are estimates — treat a small gap against Vercel as noise.')
			}

			const consentCoverage = coverageForAny(config.eventCutovers, consentEvents, range)
			if (consentCoverage.status === 'full' && consent && ga4Sessions.status === 'ok' && ga4Sessions.value > 0) {
				// Expressed as a percentage of sessions, capped since one session can fire it twice.
				const rate = Math.min(100, (sumFirstMetric(consent) / ga4Sessions.value) * 100)
				consentRate = ok(Math.round(rate * 10) / 10)
			} else if (consentCoverage.status === 'partial') {
				consentRate = unavailable('before_cutover', `Instrumented from ${consentCoverage.cutover}`)
			}
		} catch (e) {
			console.error('Visitor insights: GA4 measurement-health query failed:', (e as Error).message)
			ga4Pageviews = unavailable('source_error')
			ga4Sessions = unavailable('source_error')
		}
	}

	let vercelPageviews: MetricValue = unavailable('source_error', 'Vercel not configured')
	if (vercel) {
		try {
			const result = await vercel.pageviews(range.start, range.end)
			vercelPageviews = ok(result.total)
			vercelByDate = result.byDate
		} catch (e) {
			console.error('Visitor insights: Vercel query failed:', (e as Error).message)
			vercelPageviews = unavailable('source_error')
		}
	}

	let orders: MetricValue = unavailable('source_error', 'Sanity not configured')
	if (sanity) {
		try {
			const counts = await countOrders(
				sanity,
				config.orders.documentType,
				range.start,
				range.end,
				config.orders.excludeFilter,
			)
			orders = ok(counts.total)
		} catch (e) {
			console.error('Visitor insights: order count failed:', (e as Error).message)
			orders = unavailable('source_error')
		}
	}

	// Computed only when both operands are real numbers, and only between matching units.
	const shortfallRatio =
		ga4Pageviews.status !== 'unavailable' && vercelPageviews.status !== 'unavailable' && vercelPageviews.value > 0
			? (vercelPageviews.value - ga4Pageviews.value) / vercelPageviews.value
			: null

	// One row per day either source reported, oldest first. Vercel's byDate is only daily on short
	// ranges — granularityFor drops to week or month beyond 62 days — so the series is built only
	// when its keys look like consecutive days. A weekly bucket plotted against a daily one would
	// draw a 7x cliff that is purely an artefact of bucketing.
	const vercelDates = Object.keys(vercelByDate)
	const vercelIsDaily = vercelDates.length === 0 || vercelDates.length > (daysInRange(range) * 0.7)
	const daily: DailyPoint[] = vercelIsDaily
		? Array.from(new Set([...ga4ByDate.keys(), ...vercelDates]))
			.sort()
			.map((date) => ({
				date,
				ga4: ga4ByDate.has(date) ? (ga4ByDate.get(date) as number) : null,
				vercel: typeof vercelByDate[date] === 'number' ? vercelByDate[date] : null,
			}))
		: []

	return {
		ga4Pageviews,
		vercelPageviews,
		shortfallRatio,
		ga4Sessions,
		orders,
		consentRate,
		interpretation: interpret(ga4Pageviews, vercelPageviews, shortfallRatio, consentRate),
		daily,
	}
}

export type { MeasurementHealthData } from '../../reportData'
