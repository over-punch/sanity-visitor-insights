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

import type { CrossSourceDay, EmailCampaign, MeasurementHealthData, DailyPoint, TimelineEvent } from '../../reportData'
import { provisionalDates } from '../../core/ranges'
import type { DateRange, MetricValue } from '../../types'
import { estimated, ok, unavailable } from '../../types'
import type { SiteAnalyticsConfig } from '../../core/siteConfig'
import { coverageForAny } from '../../core/cutover'
import { captureModel, fromEmail, fromOrders, fromPageviews, grossUp, type CaptureModel } from '../../core/capture'
import type { MailchimpClient } from '../mailchimp'
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
	/** Optional: most sites have no Mailchimp audience, and TDF has none at all. */
	mailchimp?: MailchimpClient | null
	/** Report-level caveats. Sampling is pushed here so the panel shows it without extra plumbing. */
	notices?: string[]
	/**
	 * The clock, injectable for tests.
	 *
	 * `provisionalDates` already takes one — `ranges.ts` threads it deliberately — and this report
	 * called it with the default, which made the settled-day shortfall untestable: any fixture with
	 * a fixed past range has no provisional days, so every test exercised the fallback and the
	 * headline path was reached by nothing. Reverting it left the whole suite green.
	 */
	now?: Date
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
			+ `whether a GA4 data filter or stream setting changed. The coverage row on Overview shows `
			+ `whether the gap opened on a particular day, which distinguishes a break from a drift.`
	}

	if (consent.status === 'unavailable') {
		return `${base} How much of that is consent refusal cannot be measured until the consent_granted event is instrumented, so the difference is currently unexplained rather than attributed.`
	}

	/*
	 * The consent rate cannot explain the gap it was being used to explain.
	 *
	 * It is grants over GA4's own users — conditioned on having been SEEN by GA4. Anyone who
	 * refused consent and was therefore never recorded is absent from the numerator and the
	 * denominator alike, so this figure describes the people inside the sample and was being
	 * credited with part of the residual between the sample and reality. It also said "of
	 * sessions" while dividing users by users, which is the unit error this same file congratulates
	 * itself for fixing elsewhere. And `grants` is deliberately a maximum across event rows, i.e. a
	 * lower bound, which "Around" quietly promoted to a point estimate.
	 */
	const consentPercent = Math.round((1 - consent.value / 100) * 100)
	return `${base} Of the visitors GA4 did record, at least ${consentPercent}% declined analytics consent. That is measured inside GA4's own sample, so it does not explain the visitors missing from it — anyone who refused before being counted is in neither figure. The gap itself stays unexplained; ad-blocking and bot filtering are plausible and are not separately measurable.`
}

/**
 * Every date from start to end inclusive, as ISO days.
 *
 * Stepped in UTC. Doing it in local time shifts a day either side of a DST boundary, which would
 * put two identical dates in the series or skip one — on a chart whose whole subject is whether two
 * sources agree about what happened on a given day.
 *
 * @param start - first day, ISO
 * @param end - last day, ISO, included
 */
export function calendarDays(start: string, end: string): string[] {
	const first = Date.parse(`${start}T00:00:00Z`)
	const last = Date.parse(`${end}T00:00:00Z`)
	if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return []
	// Bounded. A malformed range should not spin: no window this tool offers is longer than a year,
	// and a couple of years of slack is still a chart, not a hang.
	const MAX_DAYS = 800
	const days: string[] = []
	for (let t = first; t <= last && days.length < MAX_DAYS; t += 86_400_000) {
		days.push(new Date(t).toISOString().slice(0, 10))
	}
	return days
}

/**
 * Run the measurement-health report.
 *
 * Each source is queried independently and a failure in one degrades only its own figures, so the
 * panel can always say which source did not answer rather than showing an unexplained blank.
 */
export async function measurementHealth(input: MeasurementHealthInput): Promise<MeasurementHealthData> {
	const { config, range, ga4, vercel, sanity } = input
	const mailchimp = input.mailchimp ?? null
	// Consent event names are per-site, like tester events.
	const consentEvents = config.eventNames?.consent ?? [CONSENT_EVENT]

	let ga4Pageviews: MetricValue = unavailable('source_error', 'GA4 not configured')
	let ga4Sessions: MetricValue = unavailable('source_error', 'GA4 not configured')
	let consentRate: MetricValue = unavailable('not_instrumented')
	/** Daily GA4 pageviews keyed by ISO date, for the trend. */
	const ga4ByDate = new Map<string, number>()
	/** Daily GA4 sessions, for the behavioural row of the cross-source timeline. */
	const ga4SessionsByDate = new Map<string, number>()
	/** Daily Vercel pageviews keyed by ISO date. Already fetched; previously discarded. */
	let vercelByDate: Record<string, number> = {}
	/** GA4's own purchase count, for the orders-based capture estimate. */
	let ga4Purchases: number | null = null
	/** GA4 sessions whose medium is email, for the campaign-cohort capture estimate. */
	let emailSessions: number | null = null

	if (ga4) {
		try {
			// One batched call rather than three separate quota-charged requests.
			const [views, sessions, consent, daily, purchases, emailReport] = await ga4.batchRunReports([
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
					// Sessions alongside pageviews: the cross-source timeline plots the behavioural
					// row from this, and a second metric on an existing request costs nothing while
					// a second request would cost a slot against a ten-concurrent ceiling.
					metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
					dimensions: [{ name: 'date' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
					orderBys: [{ dimension: { dimensionName: 'date' } }],
					limit: 400,
				},
				{
					// The same-event numerator for the capture model: GA4's purchase count against
					// the orders that exist. Batched with the rest, so it costs a row and not a
					// round trip.
					metrics: [{ name: 'eventCount' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
					dimensionFilter: eventNamesFilter(['purchase']),
				},
				{
					// Sessions GA4 attributes to email. The denominator side of this comes from
					// Mailchimp's unique subscriber clicks, so the two must describe the same
					// people — which they only do where campaign links carry a UTM.
					metrics: [{ name: 'sessions' }],
					dateRanges: [{ startDate: range.start, endDate: range.end }],
					dimensionFilter: {
						filter: { fieldName: 'sessionMedium', stringFilter: { matchType: 'EXACT', value: 'email' } },
					},
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

			ga4Purchases = purchases ? sumFirstMetric(purchases) : null

			// Daily sessions for the behavioural row. Read from the daily report that already
			// carries pageviews, so it costs a metric rather than another request.
			for (const row of daily?.rows ?? []) {
				const date = row.dimensions[0]
				const value = row.metrics[1]
				if (date && date.length === 8 && value !== undefined && Number.isFinite(value)) {
					ga4SessionsByDate.set(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, value)
				}
			}
			emailSessions = emailReport ? sumFirstMetric(emailReport) : null

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
	// least lossy visitor figure here — but its own counter is a client script on a first-party
	// path, so consent tooling and blocklists reach it too, just far less often than they reach GA4.
	let vercelVisitors: MetricValue = unavailable('source_error', 'Vercel not configured')
	/** Windows of the daily series that failed. Above zero, the series has a hole the size of one. */
	let vercelIncompleteWindows = 0
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
			vercelIncompleteWindows = result.incompleteWindows ?? 0
			if (vercelIncompleteWindows > 0) {
				input.notices?.push('Part of Vercel\u2019s daily series did not load, so the day-by-day comparison is switched off for this range. The range totals are unaffected.')
			}
		} catch (e) {
			console.error('Visitor insights: Vercel query failed:', (e as Error).message)
			vercelPageviews = unavailable('source_error')
			vercelVisitors = unavailable('source_error')
		}
	}

	let orders: MetricValue = unavailable('source_error', 'Sanity not configured')
	let revenue: MetricValue = unavailable('source_error', 'Sanity not configured')
	/** The exact order count, as the capture model's denominator. */
	let orderTotal: number | null = null
	/** Orders per day, for the timeline. */
	let ordersByDate: Record<string, number> = {}
	/** Revenue per day, or null when the site names no total field. */
	let revenueByDate: Record<string, number> | null = null
	let currency: string | null = null
	/** The status vocabulary this site's own orders use, so countedStatuses can be configured. */
	let orderStatuses: Record<string, number> = {}
	if (sanity) {
		try {
			const counts = await countOrders(sanity, orderQueryOptions(config.orders, range))
			orders = ok(counts.total)
			orderTotal = counts.total
			ordersByDate = counts.byDate
			revenueByDate = counts.revenueByDate
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
	// An EMPTY series is not daily. `vercelDates.length === 0 || …` returned true on the empty case,
	// so a Vercel failure — which is caught and returns `{ data: [] }` — set vercelDailyUnavailable
	// to false, said nothing, and left the row legended "complete" with a solid rule and no data.
	// The panel whose entire purpose is telling "measured nothing" from "did not measure" could not
	// tell them apart about itself.
	// A series with a failed window is not daily either, however many days survived. One window of
	// six failing on a year leaves 303 of 365 days — comfortably over the 70% bar — and the missing
	// two months would have drawn as a real outage.
	const vercelIsDaily = vercelDates.length > 0
		&& vercelIncompleteWindows === 0
		&& vercelDates.length > (daysInRange(range) * 0.7)

	/*
	 * Computed over SETTLED days only, when the daily figures exist to do it.
	 *
	 * Every range ends today, and GA4 does not finish processing for about two days — the package
	 * knows this, exports `provisionalDates`, and used the fact only to print a notice. Meanwhile
	 * this ratio differenced GA4's two unsettled days against Vercel's two complete ones, so on a
	 * seven-day range it inflated the shortfall by roughly ten points — a third of the distance to
	 * the verdict's own "treat its figures as broken" threshold, from processing lag alone.
	 *
	 * The alarm this tool exists to raise was the one most easily manufactured by a delay it had
	 * already documented.
	 */
	const unsettled = new Set(provisionalDates(range, input.now))

	/*
	 * The SAME days on both sides, not just the same provisional filter.
	 *
	 * Settling was fixed on the provisional axis and left broken on the membership one: the two
	 * sides were filtered independently and their totals differenced regardless of whether they
	 * covered the same days. `vercelIsDaily` tolerates up to 30% of days missing, so nearly a third
	 * of a range could be present on one side and absent on the other while still being called
	 * daily — and every one of those days counted as a shortfall that was really an absence.
	 */
	const comparable = vercelIsDaily
		? [...ga4ByDate.keys()].filter((date) => !unsettled.has(date) && typeof vercelByDate[date] === 'number')
		: []

	const settledShortfall = (() => {
		// A handful of shared days is a ratio of noise. Below this the whole-range totals, which at
		// least cover one consistent window each, are the better answer.
		const MIN_COMPARABLE_DAYS = 3
		if (comparable.length < MIN_COMPARABLE_DAYS) return null
		let ga4Total = 0
		let vercelTotal = 0
		for (const date of comparable) {
			ga4Total += ga4ByDate.get(date) ?? 0
			vercelTotal += vercelByDate[date] ?? 0
		}
		return vercelTotal > 0 ? (vercelTotal - ga4Total) / vercelTotal : null
	})()

	// Every day in the window is still settling, so the ratio below is the artefact, not a finding.
	if (settledShortfall === null && vercelIsDaily && unsettled.size >= daysInRange(range)) {
		input.notices?.push('Every day in this range is still being processed by Google Analytics, so the comparison against Vercel reads far worse than it is. Choose a range that ends before yesterday.')
	}

	const shortfallRatio = settledShortfall !== null
		? settledShortfall
		/*
		 * The fallback, for when too few days can be compared like for like.
		 *
		 * The comment here used to say this ran "only where daily figures are unavailable — a quarter
		 * or a year". Both halves stopped being true: chunked fetching made quarter and year come
		 * back daily, and the fallback is instead reached on a very short range ending today, where
		 * every day may be provisional — carrying not "well under a point" of bias but all of it.
		 * That case now says so rather than passing the whole-range ratio off as measured.
		 */
		: ga4Pageviews.status !== 'unavailable' && vercelPageviews.status !== 'unavailable' && vercelPageviews.value > 0
			? (vercelPageviews.value - ga4Pageviews.value) / vercelPageviews.value
			: null
	const seriesDates = vercelIsDaily
		? Array.from(new Set([...ga4ByDate.keys(), ...vercelDates]))
		: Array.from(ga4ByDate.keys())

	const daily: DailyPoint[] = seriesDates.sort().map((date) => ({
		date,
		ga4: ga4ByDate.has(date) ? (ga4ByDate.get(date) as number) : null,
		vercel: vercelIsDaily && typeof vercelByDate[date] === 'number' ? vercelByDate[date] : null,
	}))

	// Mailchimp. The audience a foundry owns, and the only count here that is neither consent-gated
	// nor blockable — which is why it replaces the site's own subscribe event rather than sitting
	// beside it.
	let audience: MetricValue = unavailable('not_applicable', 'Mailchimp is not configured for this site')
	let audienceGrowth: MetricValue = unavailable('not_applicable', 'Mailchimp is not configured for this site')
	let campaigns: EmailCampaign[] = []
	let campaignClicks: number | null = null

	if (mailchimp) {
		try {
			const [list, sent] = await Promise.all([
				mailchimp.audience({ start: range.start, end: range.end }),
				mailchimp.campaigns({ start: range.start, end: range.end }),
			])

			audience = ok(list.members)
			audienceGrowth = list.membersAtStart === null
				// Growth history is monthly, so a trailing seven-day window has no start figure to
				// difference against. Absent rather than approximated: a growth number measured over
				// a different window than the panel claims is worse than none.
				? unavailable('not_applicable', 'Mailchimp reports list growth by calendar month, so this range has no start figure')
				: ok(list.members - list.membersAtStart)

			campaigns = sent.map((campaign) => ({
				title: campaign.title,
				subject: campaign.subject,
				sentAt: campaign.sentAt,
				sent: campaign.emailsSent,
				opens: campaign.uniqueOpens,
				clicks: campaign.uniqueClicks,
				unsubscribed: campaign.unsubscribed,
			}))

			// The cohort for the third capture estimate: distinct people who clicked through, each
			// of whom should have produced a GA4 session.
			campaignClicks = sent.reduce((total, campaign) => total + campaign.uniqueClicks, 0)
		} catch (e) {
			console.error('Visitor insights: Mailchimp query failed:', (e as Error).message)
			audience = unavailable('source_error')
			audienceGrowth = unavailable('source_error')
		}
	}

	// The capture model. Each ratio is an independent estimate of the same quantity, which is what
	// makes them worth holding together: one is a curiosity, three that agree are a measurement,
	// and three that disagree say WHERE the problem is rather than merely that there is one.
	const capture = captureModel([
		ga4Purchases !== null && orderTotal !== null ? fromOrders(ga4Purchases, orderTotal) : null,
		ga4Pageviews.status !== 'unavailable' && vercelPageviews.status !== 'unavailable'
			? fromPageviews(ga4Pageviews.value, vercelPageviews.value)
			: null,
		// Only counted where the site tags its campaign links. Without a UTM the sessions are not
		// attributable to email and the ratio would measure tagging rather than capture — which is
		// a real finding, but a different one, and conflating them would hide both.
		campaignClicks !== null && emailSessions !== null ? fromEmail(emailSessions, campaignClicks) : null,
	])

	// Sessions grossed up to what they probably were. Reported as `estimated`, never as `ok` — the
	// tagged union makes it impossible to render this as a measurement by accident.
	// Traffic-shaped estimates only. Grossing sessions up by the ORDERS estimate corrects a traffic
	// figure with a purchase-tag failure rate, which are independent — so a checkout problem became
	// a multiplier on the visitor count.
	const grossed = ga4Sessions.status !== 'unavailable'
		? grossUp(ga4Sessions.value, capture, ['pageviews', 'email'])
		: null
	const estimatedSessions: MetricValue = grossed
		? estimated(
			Math.round(grossed.value),
			Math.round(grossed.low),
			Math.round(grossed.high),
			`GA4 counted ${Math.round(ga4Sessions.status === 'unavailable' ? 0 : ga4Sessions.value)} and appears to be seeing ${Math.round((capture.rate ?? 0) * 100)}% of activity, measured against ${capture.estimates[0]?.basis === 'orders' ? 'the orders that exist' : 'Vercel'}.`,
		)
		: unavailable('not_applicable', 'Not enough overlap between sources to estimate a true figure')

	/*
	 * The cross-source timeline, on a CONTIGUOUS CALENDAR — every day in the range, whether or not
	 * any source reported one.
	 *
	 * It was the union of the dates sources actually returned, which deletes an outage from the
	 * chart: on a day where GA4 reported nothing, Vercel was in weekly buckets and no order landed,
	 * the day simply was not in the array, and the line was drawn smoothly from the day before to
	 * the day after. The 24 August collapse — the founding case for this whole package — would
	 * compress itself out of the axis on exactly the ranges you would open to look for it.
	 *
	 * It also silently broke the chart's arithmetic. The pointer maps a position to an index by
	 * dividing the plot width evenly, while the x scale is a time scale over real dates — those two
	 * agree only when the days are evenly spaced. With any gap the crosshair stopped landing under
	 * the cursor, a brush selected a span nobody dragged, and the stem pitch was computed from the
	 * wrong count. A complete calendar makes index and position the same thing again.
	 */
	const crossDates = calendarDays(range.start, range.end)

	const crossSource: CrossSourceDay[] = crossDates.map((date) => ({
		date,
		vercelPageviews: vercelIsDaily && typeof vercelByDate[date] === 'number' ? vercelByDate[date] : null,
		// Pageviews, for the like-for-like comparison the chart draws as an area.
		ga4Pageviews: ga4ByDate.has(date) ? (ga4ByDate.get(date) as number) : null,
		ga4Sessions: ga4SessionsByDate.has(date) ? (ga4SessionsByDate.get(date) as number) : null,
		// Zero rather than null: Sanity is exact, so a day with no order really did have none.
		// Null here would draw a gap and read as "not measured", which is the opposite of the truth.
		orders: ordersByDate[date] ?? 0,
		revenue: revenueByDate ? revenueByDate[date] ?? 0 : null,
	}))

	// Campaign sends. Date and title only — a marker says when and what; the table below it carries
	// the campaign's actual numbers.
	const timelineEvents: TimelineEvent[] = campaigns
		.filter((campaign) => campaign.sentAt)
		.map((campaign) => ({
			date: campaign.sentAt.slice(0, 10),
			label: campaign.title,
			detail: `${formatInt(campaign.sent)} sent, ${formatInt(campaign.clicks)} clicked`,
		}))

	return {
		crossSource,
		timelineEvents,
		ga4Pageviews,
		vercelPageviews,
		vercelVisitors,
		vercelDailyUnavailable: !vercelIsDaily,
		shortfallRatio,
		ga4Sessions,
		orders,
		audience,
		audienceGrowth,
		campaigns,
		capture,
		estimatedSessions,
		revenue,
		currency,
		orderStatuses,
		consentRate,
		interpretation: interpret(ga4Pageviews, vercelPageviews, shortfallRatio, consentRate),
		daily,
	}
}

export type { MeasurementHealthData } from '../../reportData'


/** Whole number for a marker's detail line. */
function formatInt(value: number): string {
	return new Intl.NumberFormat('en-US').format(Math.round(value))
}
