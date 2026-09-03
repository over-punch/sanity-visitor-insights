/**
 * Typeface interest — viewed, tested, bought, per family.
 *
 * This is the one panel GA4's own UI cannot produce, because it joins GA4 engagement to Sanity
 * order documents. It is also the panel most easily misread, so two things are stated in the
 * response rather than left to the reader:
 *
 *   1. It measures aggregate interest per family, not one person's journey. In foundry sales the
 *      designer who tests a typeface is frequently not the person who later pays for it, and the
 *      gap between the two can be months. A low tested-to-bought ratio is therefore not a broken
 *      funnel, and the UI must not frame it as one.
 *   2. "Tested" counts only genuine engagement — a `tester_engaged` event fired when the visitor
 *      changed something. Firing on tester open would count every default-state page load as a
 *      test and make the ratio meaningless.
 */

import type { TypefaceInterestData, TypefaceInterestRow } from '../../reportData'
import type { DateRange, MetricValue } from '../../types'
import { ok, unavailable } from '../../types'
import type { SiteAnalyticsConfig } from '../../core/siteConfig'
import { applyCoverage, coverageForAny } from '../../core/cutover'
import { eventNamesFilter, type Ga4Client, type Ga4Report } from '../ga4'
import { countOrdersByTypeface, orderQueryOptions, type SanityQueryClient } from '../orders'

/** GA4 event evidencing a typeface page view. */
const VIEW_EVENT = 'view_item'

/** GA4 event evidencing real type-tester engagement. */
const TEST_EVENT = 'tester_engaged'



const INTERPRETATION_NOTE =
	'Aggregate interest per family, not individual journeys. The person who tests a typeface is often ' +
	'not the person who buys it, and may buy months later — so a low tested-to-bought ratio is not ' +
	'necessarily a conversion problem.'

/**
 * Read per-typeface event counts keyed by the GA4 `itemName` dimension.
 * Returns null when the event is not usable for this range, so the caller can distinguish
 * "no data" from "no interest".
 */
function itemRequest(range: DateRange, eventNames: string[]) {
	return {
		dimensions: [{ name: 'itemName' }],
		// totalUsers, not eventCount. These events do not fire once per person: a tester emits one
		// per slider drag and per dropdown change, and TDF maps five separate change events onto
		// the tester step. Dividing that by a per-pageview view count produced a "test rate" that
		// was events over events, unbounded above 100%, and higher for a family whose page happens
		// to carry more tester rows or whose variable font has more axes. It ranked layout, not
		// interest. journey.ts made this switch and explained why; this file did not get the lesson.
		metrics: [{ name: 'totalUsers' }],
		dateRanges: [{ startDate: range.start, endDate: range.end }],
		dimensionFilter: eventNamesFilter(eventNames),
		orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
		limit: 100,
	}
}

/** One query's result, with its own completeness rather than a shared flag. */
interface ItemCounts {
	counts: Map<string, number>
	/** GA4 withheld low-count rows, so an absent family is unknown rather than idle. */
	thresholded: boolean
	/** The 100-row cap was reached. For a foundry the long tail is most of the catalogue. */
	truncated: boolean
	sampled: boolean
}

/** Read one report into counts keyed by family, carrying its own completeness. */
function toItemCounts(report: Ga4Report): ItemCounts {
	const counts = new Map<string, number>()
	for (const row of report.rows) {
		const name = row.dimensions[0]
		const value = row.metrics[0]
		if (name && Number.isFinite(value)) counts.set(name, value as number)
	}
	return {
		counts,
		thresholded: report.thresholded,
		truncated: report.rowCount > report.rows.length,
		sampled: report.sampled,
	}
}

/** Inputs for the typeface-interest report. */
export interface TypefaceInterestInput {
	config: SiteAnalyticsConfig
	range: DateRange
	ga4: Ga4Client
	sanity: SanityQueryClient | null
	/** Report-level caveats. Sampling is pushed here so the panel shows it without extra plumbing. */
	notices?: string[]
}

/** Run the typeface-interest report. */
export async function typefaceInterest(input: TypefaceInterestInput): Promise<TypefaceInterestData> {
	const { config, range, ga4, sanity } = input

	// Tester events are per-site; TDF names five of them. Counts are summed across whichever
	// this site emits, so the tested column means the same thing everywhere.
	const testerEvents = config.eventNames?.tester ?? [TEST_EVENT]
	/** How many events feed the tester figure. Above one, the summed count is not a person count. */
	const testerEventCount = testerEvents.length

	const viewCoverage = coverageForAny(config.eventCutovers, [VIEW_EVENT], range)
	const testCoverage = coverageForAny(config.eventCutovers, testerEvents, range)

	// Only events that can answer are queried. Firing a request for an event whose coverage is
	// `none` spends a quota row to learn something the cutover map already said.
	const queryable = [
		...(viewCoverage.status === 'none' ? [] : [{ key: 'view', events: [VIEW_EVENT] }]),
		...(testCoverage.status === 'none' ? [] : testerEvents.map((event) => ({ key: 'test', events: [event] }))),
	]

	// ONE batch, not N+1 concurrent calls. TDF names five tester events, which meant six concurrent
	// requests for this window — and, once the comparison window was added, twelve against a
	// property whose concurrency ceiling is ten. A 429 on any one of them rejected the whole report.
	const reports = queryable.length > 0
		? await ga4.batchRunReports(queryable.map((q) => itemRequest(range, q.events)))
		: []

	const parts = reports.map(toItemCounts)
	const viewPart = viewCoverage.status === 'none' ? null : parts[0] ?? null
	const testParts = parts.slice(viewCoverage.status === 'none' ? 0 : 1)

	// Completeness is tracked per query, not shared. One object threaded through all N+1 calls meant
	// truncation in any single tester query marked every family's *viewed* count unknown — and both
	// ratio columns null with it, since each requires a usable viewed value.
	const viewIncomplete = Boolean(viewPart && (viewPart.thresholded || viewPart.truncated))
	const testIncomplete = testParts.some((part) => part.thresholded || part.truncated)
	const anyThresholded = parts.some((part) => part.thresholded)
	const anyTruncated = parts.some((part) => part.truncated)
	const anySampled = parts.some((part) => part.sampled)

	const viewed = viewPart ? viewPart.counts : null
	const tested = testCoverage.status === 'none' || testParts.length === 0
		? null
		: testParts.reduce<Map<string, number>>((acc, part) => {
				for (const [name, count] of part.counts) acc.set(name, (acc.get(name) ?? 0) + count)
				return acc
			}, new Map())

	let bought: Map<string, number> | null = null
	let revenue: Map<string, number> | null = null
	if (sanity) {
		try {
			const counts = await countOrdersByTypeface(
				sanity,
				orderQueryOptions(config.orders, range),
				config.orders.typefacesField,
			)
			if (counts) {
				bought = new Map(Object.entries(counts.byTypeface))
				if (counts.revenueByTypeface) revenue = new Map(Object.entries(counts.revenueByTypeface))
			}
		} catch (e) {
			console.error('Visitor insights: per-typeface order count failed:', (e as Error).message)
		}
	}

	// Union of every family seen by any source, so a family that sold but was never viewed
	// (or vice versa) still appears rather than being silently dropped.
	const families = new Set<string>([
		...(viewed?.keys() ?? []),
		...(tested?.keys() ?? []),
		...(bought?.keys() ?? []),
		...(revenue?.keys() ?? []),
	])

	// A family missing from a GA4 result means one of two different things, and they must not
	// render alike. If the result was complete, absence is a real zero. If GA4 withheld low-count
	// rows or the 100-row cap was hit, absence is unknown — and rendering it as `ok(0)` produced
	// "Viewed 0, Bought 2", which reads as a family that sold without ever being seen. That was the
	// one place this codebase broke its own rule that absence is never a measurement.
	const metric = (
		counts: Map<string, number> | null,
		family: string,
		coverage: ReturnType<typeof coverageForAny>,
		incomplete: boolean,
	): MetricValue => {
		// The reason is taken from the coverage rather than hard-coded. `none` covers three
		// different situations — never instrumented, a range before the cutover, and a recorded
		// outage — and rendering an outage as "Not tracked on this site" is both permanent-sounding
		// and untrue.
		if (counts === null) {
			if (coverage.status === 'none' && coverage.reason === 'outage') {
				return unavailable('outage', 'Not recorded for part of this range')
			}
			if (coverage.status === 'none' && coverage.reason === 'before_cutover') {
				return unavailable('before_cutover', coverage.cutover ? `Instrumented from ${coverage.cutover}` : undefined)
			}
			return unavailable('not_instrumented')
		}

		const value = counts.get(family)
		if (value === undefined) {
			return incomplete
				? unavailable('suppressed', 'GA4 withheld or truncated this row, so the count is unknown rather than zero')
				: ok(0)
		}

		// Partial coverage is applied, as the journey report already does. Without it, a Quarter
		// range on a site whose view_item cutover was three days ago divided 91 days of orders by
		// 3 days of viewers — and the buy rate clamped the resulting impossibility to a
		// plausible-looking 100%.
		return applyCoverage(value, coverage)
	}

	const rows: TypefaceInterestRow[] = [...families].map((family) => {
		const viewedMetric = metric(viewed, family, viewCoverage, viewIncomplete)
		const testedMetric = metric(tested, family, testCoverage, testIncomplete)
		const boughtMetric = bought === null ? unavailable('not_applicable', 'Orders do not resolve to typefaces on this site') : ok(bought.get(family) ?? 0)

		// Withheld where it cannot be a proportion.
		//
		// Summing distinct-user counts across several events double-counts anyone who fired more
		// than one of them, so on a site mapping multiple events onto the tester step the ratio is
		// not a rate and must not be printed as one. Clamped rather than shown above 1 in the
		// single-event case too: a value over 100% is evidence the inputs disagree, not a finding.
		const rateIsProportion = testerEventCount === 1
		const rawRate =
			viewedMetric.status !== 'unavailable' &&
			testedMetric.status !== 'unavailable' &&
			viewedMetric.value > 0
				? testedMetric.value / viewedMetric.value
				: null
		const testRate = rateIsProportion && rawRate !== null ? Math.min(1, rawRate) : null

		// The ratio a foundry actually acts on. Orders over distinct viewers — the same shape as the
		// test rate, and the column that sorts the catalogue into "looked at and not selling",
		// which is where a pricing or specimen-page problem shows up.
		const buyRate =
			viewedMetric.status !== 'unavailable' &&
			boughtMetric.status !== 'unavailable' &&
			viewedMetric.value > 0
				? Math.min(1, boughtMetric.value / viewedMetric.value)
				: null

		const revenueMetric: MetricValue = revenue === null
			? unavailable('not_applicable', 'No order total field is configured for this site')
			: ok(revenue.get(family) ?? 0)

		return {
			typeface: family,
			viewed: viewedMetric,
			tested: testedMetric,
			bought: boughtMetric,
			revenue: revenueMetric,
			testRate,
			buyRate,
		}
	})

	// Most-viewed first, with unavailable views sorting last rather than as zero.
	rows.sort((a, b) => {
		const av = a.viewed.status === 'unavailable' ? -1 : a.viewed.value
		const bv = b.viewed.status === 'unavailable' ? -1 : b.viewed.value
		return bv - av
	})

	if (anySampled) {
		input.notices?.push('GA4 answered the typeface breakdown from a sample, so these counts are estimates.')
	}

	return {
		rows,
		interpretationNote: INTERPRETATION_NOTE,
		rowsWithheld: anyThresholded,
		rowsTruncated: anyTruncated,
		revenueIsApportioned: revenue !== null,
		currency: config.orders.currency ?? null,
	}
}

export type { TypefaceInterestData, TypefaceInterestRow } from '../../reportData'
