/**
 * Journey — how far visitors get, and where they arrive.
 *
 * This is an ordered step funnel, not a path graph, and that is a deliberate limit rather than a
 * simplification. GA4's Data API has no path-exploration endpoint; Path Exploration is a UI-only
 * feature. What is available is per-event totals and `runFunnelReport`, an alpha surface that
 * returns step-conversion marginals — not observed sequences. Rendering ribbons from marginals
 * would assert that a given visitor went A to B to C when no such co-occurrence was ever measured.
 *
 * So each step is reported as its own honest total, adjacent drop-off is derived between steps, and
 * the response is explicitly flagged as an approximation for the UI to display.
 *
 * A step whose event is not instrumented on this site reports as unavailable, never as zero. On a
 * site missing `begin_checkout`, the cart-to-checkout drop-off is not "100% drop-off" — it is
 * unmeasured, and the two must not look alike.
 *
 * Steps count distinct users rather than events. Several of these events fire repeatedly per
 * visitor — `add_to_cart` runs on every selection change on two of the three sites — so an
 * event-count funnel compares a number that inflates with engagement against one that does not.
 */

import type { JourneyData, JourneyStep, LandingPage } from '../../reportData'
import type { DateRange, MetricValue } from '../../types'
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
	let topLandingPages: LandingPage[] = []
	try {
		const landings = await ga4.runReport({
			dimensions: [{ name: 'landingPage' }],
			metrics: [{ name: 'sessions' }],
			dateRanges: [{ startDate: range.start, endDate: range.end }],
			orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
			limit: 10,
		})

		topLandingPages = landings.rows.map((row) => ({
			path: row.dimensions[0] ?? '(unknown)',
			sessions: Number.isFinite(row.metrics[0]) ? (row.metrics[0] as number) : 0,
		}))
	} catch (e) {
		// Supplementary; losing it must not cost the funnel. Logged loudly rather than swallowed,
		// which is how the previous version of this block stayed broken indefinitely.
		console.error('Visitor insights: landing-page query failed:', (e as Error).message)
	}

	return { steps, topLandingPages, approximate: true, approximationNote: APPROXIMATION_NOTE }
}

export type { JourneyData, JourneyStep, LandingPage } from '../../reportData'
