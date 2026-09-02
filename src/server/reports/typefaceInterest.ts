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
import { coverageForAny } from '../../core/cutover'
import { eventNamesFilter, type Ga4Client } from '../ga4'
import { countOrdersByTypeface, type SanityQueryClient } from '../orders'

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
async function countsByItem(
	config: SiteAnalyticsConfig,
	ga4: Ga4Client,
	range: DateRange,
	eventNames: string[],
	quality: { thresholded: boolean; sampled: boolean },
): Promise<Map<string, number> | null> {
	if (coverageForAny(config.eventCutovers, eventNames, range).status === 'none') return null

	const report = await ga4.runReport({
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
	})

	// GA4 withholds low-count rows entirely rather than returning them as zero, so a quiet family
	// simply vanishes. Reporting the table as complete when that happened is the same lie as
	// rendering a missing value as zero.
	if (report.thresholded) quality.thresholded = true
	if (report.sampled) quality.sampled = true

	const counts = new Map<string, number>()
	for (const row of report.rows) {
		const name = row.dimensions[0]
		const value = row.metrics[0]
		if (name && Number.isFinite(value)) counts.set(name, value as number)
	}

	return counts
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

	const quality = { thresholded: false, sampled: false }
	// Tester events are per-site; TDF names five of them. Counts are summed across whichever
	// this site emits, so the tested column means the same thing everywhere.
	const testerEvents = config.eventNames?.tester ?? [TEST_EVENT]
	/** How many events feed the tester figure. Above one, the summed count is not a person count. */
	const testerEventCount = testerEvents.length
	const [viewed, ...testedParts] = await Promise.all([
		countsByItem(config, ga4, range, [VIEW_EVENT], quality),
		...testerEvents.map((event) => countsByItem(config, ga4, range, [event], quality)),
	])

	// Null only when every tester event is unusable; otherwise sum what did return.
	const tested = testedParts.some((m) => m !== null)
		? testedParts.reduce<Map<string, number>>((acc, part) => {
				for (const [name, count] of part ?? []) acc.set(name, (acc.get(name) ?? 0) + count)
				return acc
			}, new Map())
		: null

	let bought: Map<string, number> | null = null
	if (sanity) {
		try {
			const counts = await countOrdersByTypeface(
				sanity,
				config.orders.documentType,
				config.orders.typefacesField,
				range.start,
				range.end,
				config.orders.excludeFilter,
			)
			if (counts) bought = new Map(Object.entries(counts.byTypeface))
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
	])

	const metric = (counts: Map<string, number> | null, family: string, missingReason: 'not_instrumented' | 'not_applicable'): MetricValue =>
		counts === null ? unavailable(missingReason) : ok(counts.get(family) ?? 0)

	const rows: TypefaceInterestRow[] = [...families].map((family) => {
		const viewedMetric = metric(viewed, family, 'not_instrumented')
		const testedMetric = metric(tested, family, 'not_instrumented')
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

		return { typeface: family, viewed: viewedMetric, tested: testedMetric, bought: boughtMetric, testRate }
	})

	// Most-viewed first, with unavailable views sorting last rather than as zero.
	rows.sort((a, b) => {
		const av = a.viewed.status === 'unavailable' ? -1 : a.viewed.value
		const bv = b.viewed.status === 'unavailable' ? -1 : b.viewed.value
		return bv - av
	})

	if (quality.sampled) {
		input.notices?.push('GA4 answered the typeface breakdown from a sample, so these counts are estimates.')
	}

	return { rows, interpretationNote: INTERPRETATION_NOTE, rowsWithheld: quality.thresholded }
}

export type { TypefaceInterestData, TypefaceInterestRow } from '../../reportData'
