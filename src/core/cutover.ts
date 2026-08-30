/**
 * Event instrumentation history — when an event started, and when it stopped.
 *
 * GA4 cannot backfill events: data from before an event was instrumented does not exist and never
 * will. A range spanning a cutover therefore mixes two measurement regimes, and a chart drawn
 * across it reads as a change in visitor behaviour when it is really a change in what was counted.
 *
 * Outages are the same problem arriving from the other direction, and are easy to miss because the
 * event still exists in the code. Darden is the worked example: its ecommerce events fired normally
 * until a script-loading change on 2025-11-20 stopped them reaching GA4 for nine months. Every one
 * of those days returns a real, honest zero from the API — a zero that means "not recorded", not
 * "no sales". Without an outage recorded here, a yearly funnel would render that as a collapse in
 * trade rather than as a gap in measurement.
 *
 * This lives in the package rather than in each site repo so all three foundries share one model
 * and one set of semantics, and so the Studio panel and the server handler agree by construction.
 */

import type { DateRange, MetricValue } from '../types'
import { unavailable, partial } from '../types'

/** An event that predates this work — long-running, with no start discontinuity to mark. */
export const PREEXISTING = 'preexisting' as const

/**
 * A period during which an event stopped reaching GA4 despite still existing in the code.
 * `until: null` means it is still broken as of now.
 */
export interface EventOutage {
	/** First ISO date with no data. */
	start: string
	/** ISO date it resumed, or null if unresolved. */
	until: string | null
	/** Short human-readable cause, shown in the UI next to the affected figure. */
	reason?: string
}

/** An event with a start date and, optionally, periods where it stopped firing. */
export interface EventHistory {
	/** When it began firing: `PREEXISTING`, or an ISO `YYYY-MM-DD` deploy date. */
	from: typeof PREEXISTING | string
	/** Periods where it stopped. Order does not matter. */
	outages?: EventOutage[]
}

/**
 * When an event fired on a site.
 * `PREEXISTING` = live before this work began. `null` = planned, not yet deployed.
 * An ISO `YYYY-MM-DD` string = the deploy date. An `EventHistory` adds outages.
 */
export type EventCutover = typeof PREEXISTING | string | null | EventHistory

/** How completely an event covers a requested range. */
export type Coverage =
	| { status: 'full' }
	| {
			status: 'partial'
			reason: 'spans_cutover' | 'spans_outage'
			/** Present when the range starts before the event was instrumented. */
			cutover?: string
			/** Outages overlapping the range. Empty for a pure cutover overlap. */
			outages: EventOutage[]
	  }
	| {
			status: 'none'
			reason: 'not_instrumented' | 'before_cutover' | 'unknown_event' | 'outage'
			cutover?: string
			/** Present when the whole range fell inside an outage. */
			outages?: EventOutage[]
	  }

/** Normalise the shorthand forms into an EventHistory, or null when not instrumented. */
function toHistory(cutover: EventCutover | undefined): EventHistory | null {
	if (cutover === null || cutover === undefined) return null
	if (typeof cutover === 'string') return { from: cutover }
	if (!cutover.from) return null
	return cutover
}

/** Whether two inclusive date ranges overlap at all. */
function overlaps(aStart: string, aEnd: string | null, bStart: string, bEnd: string): boolean {
	// A null end means "ongoing", so it extends past any range end.
	return aStart <= bEnd && (aEnd === null || aEnd >= bStart)
}

/**
 * Determine how well an event covers a date range.
 *
 * @param cutovers - the site's event history map
 * @param eventName - GA4 event name to look up
 * @param range - the requested range
 */
export function coverageForRange(
	cutovers: Readonly<Record<string, EventCutover>>,
	eventName: string,
	range: Pick<DateRange, 'start' | 'end'>,
): Coverage {
	if (!(eventName in cutovers)) return { status: 'none', reason: 'unknown_event' }

	const history = toHistory(cutovers[eventName])
	if (!history) return { status: 'none', reason: 'not_instrumented' }

	// --- start date -----------------------------------------------------------
	let cutover: string | undefined
	let startsBeforeCutover = false

	if (history.from !== PREEXISTING) {
		const cutoverTime = Date.parse(history.from)
		// An unparseable date is a config error; treat it as unknown rather than silently trusting it.
		if (Number.isNaN(cutoverTime)) return { status: 'none', reason: 'unknown_event' }

		cutover = history.from
		if (Date.parse(range.end) < cutoverTime) return { status: 'none', reason: 'before_cutover', cutover }
		startsBeforeCutover = Date.parse(range.start) < cutoverTime
	}

	// --- outages --------------------------------------------------------------
	const hit = (history.outages ?? []).filter((o) => overlaps(o.start, o.until, range.start, range.end))

	// A range sitting entirely inside one outage has no usable data at all.
	const swallowed = hit.find((o) => o.start <= range.start && (o.until === null || o.until > range.end))
	if (swallowed) return { status: 'none', reason: 'outage', outages: [swallowed], cutover }

	if (hit.length > 0) return { status: 'partial', reason: 'spans_outage', outages: hit, cutover }
	if (startsBeforeCutover) return { status: 'partial', reason: 'spans_cutover', outages: [], cutover }

	return { status: 'full' }
}

/**
 * Wrap a raw count in a MetricValue that reflects the event's coverage of the range.
 *
 * Call this instead of returning a bare number, so a value that only covers part of the range
 * carries that fact with it all the way to the renderer.
 *
 * @param count - the number GA4 returned, or null if the query could not run
 * @param coverage - result of coverageForRange for the same event and range
 */
export function applyCoverage(count: number | null, coverage: Coverage): MetricValue {
	if (coverage.status === 'none') {
		if (coverage.reason === 'outage') {
			const outage = coverage.outages?.[0]
			return unavailable('outage', outage ? describeOutage(outage) : undefined)
		}
		return unavailable(
			coverage.reason === 'before_cutover' ? 'before_cutover' : 'not_instrumented',
			coverage.cutover ? `Instrumented from ${coverage.cutover}` : undefined,
		)
	}

	if (count === null) return unavailable('source_error')

	if (coverage.status === 'partial') {
		if (coverage.reason === 'spans_outage') {
			const outage = coverage.outages[0]
			// coveredFrom is the outage end where known, since that is when data resumes.
			const from = outage?.until ?? outage?.start ?? coverage.cutover ?? ''
			return partial(count, from, `Undercounted: ${describeOutage(outage)}`)
		}

		const from = coverage.cutover ?? ''
		return partial(count, from, `Only counted from ${from}, when this event was added`)
	}

	return { status: 'ok', value: count }
}

/**
 * Coverage across several events that mean the same thing, taking the best of them.
 *
 * A site mapping five tester events onto one concept has usable data if any one of them has it,
 * so the strongest coverage wins rather than the weakest.
 */
export function coverageForAny(
	cutovers: Readonly<Record<string, EventCutover>>,
	eventNames: readonly string[],
	range: Pick<DateRange, 'start' | 'end'>,
): Coverage {
	if (eventNames.length === 0) return { status: 'none', reason: 'unknown_event' }

	const all = eventNames.map((name) => coverageForRange(cutovers, name, range))
	return (
		all.find((c) => c.status === 'full') ??
		all.find((c) => c.status === 'partial') ??
		all[0] ?? { status: 'none', reason: 'unknown_event' }
	)
}

/** One-line description of an outage, for display beside an affected figure. */
export function describeOutage(outage: EventOutage | undefined): string {
	if (!outage) return 'an outage affected part of this range'
	const period = outage.until ? `${outage.start} to ${outage.until}` : `${outage.start} onwards`
	return outage.reason ? `not recorded ${period} (${outage.reason})` : `not recorded ${period}`
}

/**
 * Human-readable notices for every event in a range that is not fully covered.
 * Surfaced in the report envelope so the panel can show caveats without recomputing them.
 */
export function coverageNotices(
	cutovers: Readonly<Record<string, EventCutover>>,
	eventNames: readonly string[],
	range: Pick<DateRange, 'start' | 'end'>,
): string[] {
	const notices: string[] = []

	for (const name of eventNames) {
		const coverage = coverageForRange(cutovers, name, range)

		if (coverage.status === 'partial' && coverage.reason === 'spans_outage') {
			notices.push(`${name} was ${describeOutage(coverage.outages[0])}, so figures for this range are too low — not a real decline.`)
		} else if (coverage.status === 'partial') {
			notices.push(`${name} was instrumented on ${coverage.cutover}; figures before that date are missing, not zero.`)
		} else if (coverage.status === 'none' && coverage.reason === 'outage') {
			notices.push(`${name} was ${describeOutage(coverage.outages?.[0])}, covering this whole range. The figure is unavailable, not zero.`)
		} else if (coverage.status === 'none' && coverage.reason === 'not_instrumented') {
			notices.push(`${name} is not instrumented on this site, so it cannot be reported for any range.`)
		} else if (coverage.status === 'none' && coverage.reason === 'before_cutover') {
			notices.push(`${name} did not exist during this range; it was instrumented on ${coverage.cutover}.`)
		}
	}

	return notices
}
