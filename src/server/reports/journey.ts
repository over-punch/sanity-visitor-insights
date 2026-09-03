/**
 * Journey — how far visitors get, and where they arrive.
 *
 * Two ways of measuring this, and the report says which one it used.
 *
 * `runFunnelReport` is preferred and is tried first. It returns an ORDERED, CLOSED funnel: a user
 * must have entered at step one, and each later step counts only users for whom the earlier steps
 * actually happened. That is a real observed sequence.
 *
 * An earlier version of this file asserted that the endpoint "returns step-conversion marginals —
 * not observed sequences" and built independent per-step totals instead. That was wrong, and it
 * meant the panel displayed a prominent caution card describing a GA4 limitation that does not
 * exist. The endpoint is v1alpha and Google documents it as subject to breaking change, and it
 * draws on a separate quota — those are the real reasons for caution, and they are reasons to keep
 * a fallback, not reasons to avoid it.
 *
 * When the funnel call fails, the per-step totals remain as the fallback. They are honest but
 * weaker: a visitor counted at one step is not necessarily the visitor counted at the next. The
 * response carries `measurement` so the UI can say which one the reader is looking at rather than
 * describing both the same way.
 *
 * A step whose event is not instrumented on this site reports as unavailable, never as zero. On a
 * site missing `begin_checkout`, the cart-to-checkout drop-off is not "100% drop-off" — it is
 * unmeasured, and the two must not look alike.
 *
 * Steps count distinct users rather than events. Several of these events fire repeatedly per
 * visitor — `add_to_cart` runs on every selection change on two of the three sites — so an
 * event-count funnel compares a number that inflates with engagement against one that does not.
 */

import type { JourneyData, JourneyOutcome, JourneyStep, LandingPage } from '../../reportData'
import { unavailable, type DateRange, type MetricValue } from '../../types'
import type { SiteAnalyticsConfig } from '../../core/siteConfig'
import { applyCoverage, coverageForAny, coverageForRange } from '../../core/cutover'
import { eventNamesFilter, sumFirstMetric, type Ga4Client } from '../ga4'

/** Default tester event, used when a site does not name its own. */
const TESTER_DEFAULT = 'tester_engaged'

/** The funnel, in order. Each entry names the GA4 event that evidences the step. */
export const JOURNEY_STEPS = [
	{ key: 'landed', label: 'Landed', event: 'page_view' },
	{ key: 'viewed_typeface', label: 'Viewed a typeface', event: 'view_item' },
	{ key: 'tested', label: 'Used the type tester', event: 'tester_engaged' },
	{ key: 'added_to_cart', label: 'Added to cart', event: 'add_to_cart' },
	{ key: 'began_checkout', label: 'Began checkout', event: 'begin_checkout' },
	{ key: 'purchased', label: 'Purchased', event: 'purchase' },
] as const




/** How the funnel figures were obtained, so the UI can describe them accurately. */
const SEQUENCE_NOTE =
	'A tracked funnel. Each step counts users who reached it having completed the earlier steps, ' +
	'so this is an observed sequence rather than a set of independent totals.'

const APPROXIMATION_NOTE =
	'These are independent per-step totals, not tracked journeys. GA4 cannot report the actual path a ' +
	'visitor took, so a visitor counted at one step is not necessarily the same visitor counted at the next.'

/**
 * Run the journey report.
 *
 * All step queries go in one batched call rather than one request per step, which would otherwise
 * make this the most quota-expensive panel in the tool.
 */
export async function journey(config: SiteAnalyticsConfig, ga4: Ga4Client, range: DateRange, notices?: string[]): Promise<JourneyData> {
	// The tester step is whatever this site calls it. TDF emits five distinct tester events and
	// has for a long time; forcing a single canonical name on every site would throw that away.
	const testerEvents = config.eventNames?.tester ?? [TESTER_DEFAULT]

	const coverages = JOURNEY_STEPS.map((step) => {
		const events = step.event === TESTER_DEFAULT ? testerEvents : [step.event]
		return {
			step,
			events,
			coverage: events.length > 1
				? coverageForAny(config.eventCutovers, events, range)
				: coverageForRange(config.eventCutovers, events[0] ?? step.event, range),
		}
	})

	const queryable = coverages.filter((entry) => entry.coverage.status !== 'none')

	// One request per step, filtered to that step's event or events. A site mapping several
	// events onto one step gets them summed, since they describe the same interaction.
	const reports = await ga4.batchRunReports(
		queryable.map((entry) => ({
			// totalUsers, not eventCount. A funnel step means "how many people got this far", and
			// these events do not fire once per person: add_to_cart runs on every selection change
			// on MCKL and TDF, measured at 5.0 and 3.4 events per user over 90 days, while purchase
			// fires once per order. Dividing raw event counts between those steps produced a
			// conversion rate that was really a ratio of two different things.
			metrics: [{ name: 'totalUsers' }],
			dateRanges: [{ startDate: range.start, endDate: range.end }],
			dimensionFilter: eventNamesFilter(entry.events),
		})),
	)

	const countsByEvent = new Map<string, number>()
	let sampled = false
	queryable.forEach((entry, index) => {
		const report = reports[index]
		if (!report) return
		if (report.sampled) sampled = true
		countsByEvent.set(entry.step.event, sumFirstMetric(report))
	})

	if (sampled) notices?.push('GA4 answered part of this funnel from a sample, so the step counts are estimates.')

	const steps: JourneyStep[] = []
	let previousMeasurable: number | null = null

	for (const { step, coverage } of coverages) {
		const raw = countsByEvent.has(step.event) ? (countsByEvent.get(step.event) as number) : null
		const count = applyCoverage(raw, coverage)

		const current = count.status === 'unavailable' ? null : count.value
		const conversionFromPrevious =
			previousMeasurable !== null && current !== null && previousMeasurable > 0
				? current / previousMeasurable
				: null

		steps.push({ key: step.key, label: step.label, event: step.event, count, conversionFromPrevious })

		// Only advance the baseline on a measurable step, so an unavailable rung does not
		// silently make the next step's conversion look like a collapse.
		if (current !== null) previousMeasurable = current
	}

	// Where sessions BEGIN, not where they end.
	//
	// This block queried `metrics: [{ name: 'exits' }]` for a "where sessions ended" table. `exits`
	// and `exitRate` are Universal Analytics metrics that GA4 never shipped — the Data API answers
	// "Field exits is not a valid metric", verified against the live API on 2026-09-01. The request
	// 400'd on every call for the life of the package, the catch swallowed it, and the table never
	// rendered once. Nothing surfaced that, because a silent empty array looks like a quiet week.
	//
	// GA4's asymmetry is the thing to design around: it exposes entries and not exits. `landingPage`
	// is the page a session started on, which answers the more useful half anyway — pair it with a
	// referrer and it says which page a source actually delivers people to.
	// A real, ordered funnel where the endpoint allows it.
	//
	// Only rungs this site instruments are included — asking GA4 for a step whose event never fires
	// would close the funnel at that point and report zero for everything after it, which reads as
	// a catastrophic drop-off rather than as an uninstrumented site.
	let sequencedSteps: JourneyStep[] | null = null
	const funnelRungs = coverages
		.filter((entry) => entry.coverage.status !== 'none')
		.map((entry) => ({ step: entry.step, events: entry.events, coverage: entry.coverage }))

	if (funnelRungs.length >= 2) {
		try {
			const funnel = await ga4.runFunnelReport(
				funnelRungs.map((rung) => ({ name: rung.step.label, eventNames: rung.events })),
				{ startDate: range.start, endDate: range.end },
			)

			if (funnel.sampled) {
				notices?.push('GA4 answered this funnel from a sample, so the step counts are estimates.')
			}

			// Matched by name rather than by position: GA4 echoes the names it was given, and a
			// mismatch means the response does not describe the funnel that was asked for — better
			// to fall back than to line up rows that may not correspond.
			const byName = new Map(funnel.steps.map((row) => [row.name, row]))
			if (funnelRungs.every((rung) => byName.has(rung.step.label))) {
				sequencedSteps = funnelRungs.map((rung, index) => {
					const row = byName.get(rung.step.label) as NonNullable<ReturnType<typeof byName.get>>
					const previous = index > 0 ? byName.get(funnelRungs[index - 1]!.step.label) : undefined
					return {
						key: rung.step.key,
						label: rung.step.label,
						event: rung.step.event,
						count: applyCoverage(row.activeUsers, rung.coverage),
						// GA4's own completion rate where it gave one; otherwise derived from the
						// adjacent step, which in a closed funnel is a genuine continuation rate.
						conversionFromPrevious: index === 0
							? null
							: row.completionRate ?? (previous && previous.activeUsers > 0
								? row.activeUsers / previous.activeUsers
								: null),
					}
				})
			}
		} catch (e) {
			// Expected on any property where the alpha endpoint is unavailable or the funnel quota
			// is spent. The per-step totals below still answer the question, less precisely.
			console.warn('Visitor insights: funnel report unavailable, using per-step totals:', (e as Error).message)
		}
	}

	let topLandingPages: LandingPage[] = []
	try {
		const landings = await ga4.runReport({
			// landingPagePlusQueryString, not landingPage. The bare dimension strips the query, so
			// every paid landing page collapsed into its organic twin and no utm_ or gclid survived
			// — which made the one table that could have distinguished an ad landing page from the
			// page it copies unable to tell them apart.
			dimensions: [{ name: 'landingPagePlusQueryString' }],
			// Engagement alongside volume. Ranked by sessions alone, a page delivering 200 arrivals
			// that leave immediately looks identical to one that feeds the shop, so the table listed
			// the busiest pages rather than the ones worth doing something about.
			metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
			dateRanges: [{ startDate: range.start, endDate: range.end }],
			orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
			limit: 25,
		})

		topLandingPages = landings.rows.map((row) => {
			const sessions = Number.isFinite(row.metrics[0]) ? (row.metrics[0] as number) : 0
			const engaged = Number.isFinite(row.metrics[1]) ? (row.metrics[1] as number) : null
			return {
				path: row.dimensions[0] ?? '(unknown)',
				sessions,
				engagedSessions: engaged,
				// Withheld rather than shown as 0% when there are no sessions to divide by.
				engagementRate: engaged !== null && sessions > 0 ? engaged / sessions : null,
			}
		})
	} catch (e) {
		// Supplementary; losing it must not cost the funnel. Logged loudly rather than swallowed,
		// which is how the previous version of this block stayed broken indefinitely.
		console.error('Visitor insights: landing-page query failed:', (e as Error).message)
	}

	return {
		steps: sequencedSteps ?? steps,
		topLandingPages,
		outcomes: await otherOutcomes(config, ga4, range),
		measurement: sequencedSteps ? 'sequence' : 'independent-totals',
		approximate: !sequencedSteps,
		approximationNote: sequencedSteps ? SEQUENCE_NOTE : APPROXIMATION_NOTE,
	}
}

/**
 * The conversions that are not a licence sale.
 *
 * The funnel ends at `purchase`, which made every other successful outcome look like a drop-off.
 * A visitor who read three typeface pages and submitted a commission enquiry was scored as leaking
 * between "Viewed a typeface" and "Added to cart" — and a commission is worth many multiples of a
 * licence. Darden has fired `enquiry_submit` throughout and no report read it.
 *
 * Counted as distinct users over the same window as the funnel, so they sit on the same scale as
 * its rungs without pretending to be a step in the same sequence — they are alternative endings,
 * not a later stage.
 */
async function otherOutcomes(
	config: SiteAnalyticsConfig,
	ga4: Ga4Client,
	range: DateRange,
): Promise<JourneyOutcome[]> {
	const defined: Array<{ key: string; label: string; events: string[]; note: string }> = [
		{
			key: 'enquiry',
			label: 'Submitted an enquiry',
			events: config.eventNames?.enquiry ?? [],
			note: 'A custom-typeface or licensing enquiry — worth many multiples of a licence sale.',
		},
		{
			key: 'subscribe',
			label: 'Joined the mailing list',
			events: config.eventNames?.subscribe ?? [],
			note: 'The only audience a foundry owns outright rather than renting from a referrer.',
		},
		{
			key: 'asset',
			label: 'Downloaded a trial or specimen',
			events: config.eventNames?.assetDownload ?? [],
			note: 'The moment a buyer takes the work away to argue for it internally.',
		},
	]

	const active = defined.filter((outcome) => outcome.events.length > 0)
	if (active.length === 0) return []

	const coverages = active.map((outcome) => coverageForAny(config.eventCutovers, outcome.events, range))

	// One batch, one quota charge, one round trip — the same discipline the funnel steps use.
	const reports = await ga4.batchRunReports(
		active.map((outcome) => ({
			metrics: [{ name: 'totalUsers' }],
			dateRanges: [{ startDate: range.start, endDate: range.end }],
			dimensionFilter: eventNamesFilter(outcome.events),
		})),
	).catch((e) => {
		console.warn('Visitor insights: outcome counts unavailable:', (e as Error).message)
		return null
	})

	return active.map((outcome, index) => {
		const coverage = coverages[index]!
		const report = reports?.[index]
		return {
			key: outcome.key,
			label: outcome.label,
			note: outcome.note,
			count: report && coverage.status !== 'none'
				? applyCoverage(sumFirstMetric(report), coverage)
				: unavailable(coverage.status === 'none' ? 'not_instrumented' : 'source_error'),
		}
	})
}

export type { JourneyData, JourneyOutcome, JourneyStep, LandingPage } from '../../reportData'
