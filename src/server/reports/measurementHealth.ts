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
import { countOrders, orderQueryOptions, type SanityQueryClient } from '../orders'

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
		// Rounded UP, not to nearest: a 4.5% gap rounded to "within 5%" from a branch whose
		// condition was "< 5%", which reads as the boundary being met exactly when it was not.
		const bound = Math.ceil(Math.abs(shortfall) * 100)
		return `GA4 and Vercel agree to within ${bound}% on pageviews. Nothing here suggests a measurement problem.`
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
	// Both directions. A surplus of the same magnitude — GA4 reporting 2.5x Vercel, from bot
	// traffic or a double-fired tag or a second stream — is an equally clear measurement failure,
	// and it used to fall through to a sentence explaining it with consent refusal, which cannot
	// account for GA4 exceeding Vercel in either direction.
	if (shortfall < -0.6) {
		return `${base} GA4 is reporting far MORE than Vercel, which consent and blocking cannot cause — `
			+ `they only ever reduce GA4. Look for a double-fired tag, a second data stream on the `
			+ `property, or bot traffic GA4 is counting and Vercel is not.`
	}

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
					metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
				},
				{
					// totalUsers, not eventCount. This figure is divided by a user count to make a
					// rate, and one visitor can fire the consent event more than once — which is
					// why the old computation needed a Math.min(100) clamp to stay plausible. A
					// clamp that exists to hide a unit mismatch is the tell, not the fix.
					metrics: [{ name: 'totalUsers' }],
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

			// The consent denominator. Users rather than sessions, to match the numerator.
			const ga4Users = sessions
				? sessions.rows.reduce((total, row) => {
						const value = row.metrics[1]
						return value !== undefined && Number.isFinite(value) ? total + value : total
					}, 0)
				: 0
			if (views?.sampled || sessions?.sampled) {
				input.notices?.push('GA4 answered from a sample, so its pageview and session figures are estimates — treat a small gap against Vercel as noise.')
			}

			const consentCoverage = coverageForAny(config.eventCutovers, consentEvents, range)
			if (consentCoverage.status === 'full' && consent && ga4Users > 0) {
				// Users who granted consent over users GA4 saw. Both sides are now the same unit, so
				// no clamp is needed and a value above 100% would be a real signal rather than noise
				// to be hidden. It is still bounded, because a rate over 1 here means the two
				// queries disagree and the figure should not be shown as if it were sound.
				// The consent report is dimensioned by eventName, so each row is distinct users FOR THAT
				// EVENT. Summing them double-counts anyone who fired two — which is the same
				// events-over-events mistake this file's comment above says it was fixing. The max
				// is the tightest correct bound available from this response: at least that many
				// distinct people granted consent, and no row can exceed the true union.
				const grants = consent.rows.reduce((most, row) => {
					const value = row.metrics[0]
					return value !== undefined && Number.isFinite(value) ? Math.max(most, value) : most
				}, 0)
				const raw = grants / ga4Users
				consentRate = raw <= 1
					? ok(Math.round(raw * 1000) / 10)
					: unavailable('source_error', 'Consent grants exceed the users GA4 reported, so the two queries disagree')
			} else if (consentCoverage.status === 'full' && consent && ga4Users === 0) {
				// Instrumented, but there is no denominator. Distinct from "never instrumented",
				// which is what this used to fall through to — telling the reader to go instrument
				// an event they already have.
				consentRate = unavailable('source_error', 'GA4 reported no users in this range, so there is nothing to divide by')
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
	// Vercel's own visitor count. Fetched on every call and previously discarded, though it is the
	// only visitor figure in the tool that consent refusal and ad-blocking cannot reduce.
	let vercelVisitors: MetricValue = unavailable('source_error', 'Vercel not configured')
	if (vercel) {
		try {
			const result = await vercel.pageviews(range.start, range.end)
			// Null rather than zero when Vercel's response did not carry the figure: this panel
			// exists to distinguish "measured nothing" from "did not measure", and it must hold
			// itself to that first.
			vercelPageviews = result.total === null
				? unavailable('source_error', 'Vercel returned no pageview total')
				: ok(result.total)
			vercelVisitors = result.visitors === null
				? unavailable('source_error', 'Vercel returned no visitor count')
				: ok(result.visitors)
			vercelByDate = result.byDate
		} catch (e) {
			console.error('Visitor insights: Vercel query failed:', (e as Error).message)
			vercelPageviews = unavailable('source_error')
			vercelVisitors = unavailable('source_error')
		}
	}

	let orders: MetricValue = unavailable('source_error', 'Sanity not configured')
	let revenue: MetricValue = unavailable('source_error', 'Sanity not configured')
	let currency: string | null = null
	/** The status vocabulary this site's own orders use, so countedStatuses can be configured. */
	let orderStatuses: Record<string, number> = {}
	if (sanity) {
		try {
			const counts = await countOrders(sanity, orderQueryOptions(config.orders, range))
			orders = ok(counts.total)
			// Revenue was computed on every one of these requests and thrown away, which is the
			// same sin this file's other comments congratulate themselves for fixing. It is also
			// the figure the owner opens the tool for, and the only one in the package that GA4's
			// collapse could not touch.
			revenue = counts.revenue === null
				? unavailable('not_applicable', 'No order total field is configured for this site')
				: ok(counts.revenue)
			currency = config.orders.currency ?? null
			orderStatuses = counts.byStatus
			if (counts.ordersMissingTotal > 0) {
				input.notices?.push(
					`${counts.ordersMissingTotal} of ${counts.total} counted orders carry no usable total, ` +
					`so revenue covers fewer orders than the order count.`,
				)
			}
			if (counts.excludedByStatus > 0) {
				input.notices?.push(
					`${counts.excludedByStatus} order${counts.excludedByStatus === 1 ? '' : 's'} in this range ` +
					`did not carry a counted status and ${counts.excludedByStatus === 1 ? 'is' : 'are'} excluded from every figure.`,
				)
			}
		} catch (e) {
			console.error('Visitor insights: order count failed:', (e as Error).message)
			orders = unavailable('source_error')
			revenue = unavailable('source_error')
		}
	}

	// Computed only when both operands are real numbers, and only between matching units.
	const shortfallRatio =
		ga4Pageviews.status !== 'unavailable' && vercelPageviews.status !== 'unavailable' && vercelPageviews.value > 0
			? (vercelPageviews.value - ga4Pageviews.value) / vercelPageviews.value
			: null

	// Vercel's byDate is only daily on short ranges — granularityFor drops to week or month beyond
	// 62 days. A weekly bucket plotted against a daily one would draw a 7x cliff that is purely an
	// artefact of bucketing, so Vercel is omitted from the series when its keys are not days.
	//
	// The whole chart used to be dropped in that case. That was the wrong call: GA4's own series is
	// daily at every range, and the chart exists because of the 24 August collapse — so it was
	// disappearing at exactly the 90-day range where someone would go looking for when the gap
	// opened. GA4 alone still dates the cliff; the second line is what is missing, and the panel is
	// told so rather than left to render nothing.
	const vercelDates = Object.keys(vercelByDate)
	const vercelIsDaily = vercelDates.length === 0 || vercelDates.length > (daysInRange(range) * 0.7)
	const seriesDates = vercelIsDaily
		? Array.from(new Set([...ga4ByDate.keys(), ...vercelDates]))
		: Array.from(ga4ByDate.keys())

	const daily: DailyPoint[] = seriesDates.sort().map((date) => ({
		date,
		ga4: ga4ByDate.has(date) ? (ga4ByDate.get(date) as number) : null,
		vercel: vercelIsDaily && typeof vercelByDate[date] === 'number' ? vercelByDate[date] : null,
	}))

	return {
		ga4Pageviews,
		vercelPageviews,
		vercelVisitors,
		vercelDailyUnavailable: !vercelIsDaily,
		shortfallRatio,
		ga4Sessions,
		orders,
		revenue,
		currency,
		orderStatuses,
		consentRate,
		interpretation: interpret(ga4Pageviews, vercelPageviews, shortfallRatio, consentRate),
		daily,
	}
}

export type { MeasurementHealthData } from '../../reportData'
