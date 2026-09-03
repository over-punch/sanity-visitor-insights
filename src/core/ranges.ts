/**
 * Date-range resolution.
 *
 * Every range is resolved against one declared timezone — the GA4 property's — because the three
 * sources bucket time differently: GA4 by the property timezone, Vercel by UTC, Sanity `_createdAt`
 * by UTC. Without a single anchor, an order placed near midnight lands in different weeks depending
 * on which source you ask, which corrupts exactly the cross-source comparison this tool exists for.
 */

import type { DateRange, RangeKey } from '../types'

/** GA4 does not finalise the most recent days. Figures inside this window may still rise. */
export const GA4_PROCESSING_LAG_DAYS = 2

/** Format a Date as `YYYY-MM-DD` in the given IANA timezone. */
export function formatInTimeZone(date: Date, timeZone: string): string {
	// en-CA gives ISO-ordered parts, which is what we want to reassemble.
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(date)

	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
	return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * How far the given instant's wall clock in `timeZone` sits from UTC, in milliseconds.
 *
 * @param date - the instant to measure at; the offset changes across DST boundaries
 */
function zoneOffsetMs(date: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(date)

	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
	const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
	return asIfUtc - date.getTime()
}

/**
 * The UTC instant at which a calendar day begins in a timezone.
 *
 * Orders are stored as UTC `_createdAt`, and every range in this tool is a set of calendar dates in
 * the GA4 property's timezone. Bounding an order query with a bare `${date}T00:00:00Z` therefore
 * asks for a different window than the one GA4 was asked for — seven or eight hours out for a
 * US-Pacific property. At a handful of orders a day that is a visible swing in a figure the panel
 * presents as exact, and it always moved orders in one direction, never both.
 *
 * @param isoDate - `YYYY-MM-DD` in `timeZone`
 * @param timeZone - IANA timezone
 * @returns an ISO 8601 instant in UTC
 */
export function zonedDayStartUtc(isoDate: string, timeZone: string): string {
	const naive = Date.parse(`${isoDate}T00:00:00Z`)
	if (Number.isNaN(naive)) throw new Error(`Invalid ISO date: ${isoDate}`)

	// Two passes: the first guess can land on the wrong side of a DST transition, in which case its
	// offset is the wrong one to subtract. Re-measuring at the corrected instant settles it for
	// every zone whose transition is away from local midnight — which is all of them in practice,
	// including both foundry zones, and verified across spring-forward and fall-back and for
	// non-hour offsets (Kolkata +05:30, Kathmandu +05:45, Chatham +12:45/+13:45).
	//
	// It does NOT settle for a zone that transitions AT local midnight: the second pass measures
	// the offset at the transition instant itself and never converges, leaving the day boundary an
	// hour out in either direction (Santiago, Havana, Beirut, Cairo). Nothing double-counts,
	// because day N's end is day N+1's start by construction, so the window merely shifts by an
	// hour against the one GA4 was asked for. None of the three foundries uses such a zone; this is
	// recorded rather than fixed because a third pass does not converge either — it needs the
	// transition table, not another probe.
	let instant = naive - zoneOffsetMs(new Date(naive), timeZone)
	instant = naive - zoneOffsetMs(new Date(instant), timeZone)
	return new Date(instant).toISOString()
}

/**
 * The UTC instant at which a calendar day ends in a timezone, exclusive.
 *
 * Exclusive rather than 23:59:59 so the last second of the day cannot be dropped, and so a day
 * that is 23 or 25 hours long across a DST change is still bounded correctly.
 *
 * @param isoDate - `YYYY-MM-DD` in `timeZone`
 * @param timeZone - IANA timezone
 */
export function zonedDayEndUtc(isoDate: string, timeZone: string): string {
	return zonedDayStartUtc(shiftDays(isoDate, 1), timeZone)
}

/** Shift an ISO `YYYY-MM-DD` date by a whole number of days. */
export function shiftDays(isoDate: string, days: number): string {
	const time = Date.parse(`${isoDate}T00:00:00Z`)
	if (Number.isNaN(time)) throw new Error(`Invalid ISO date: ${isoDate}`)
	return new Date(time + days * 86_400_000).toISOString().slice(0, 10)
}

/** Inclusive whole days between two ISO dates. */
export function daysBetween(start: string, end: string): number {
	return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
}

/** How many days each range key spans. */
/** Trailing window length in days, for the named ranges. `custom` carries its own dates. */
export const RANGE_DAYS: Record<Exclude<RangeKey, 'custom'>, number> = {
	week: 7,
	month: 30,
	quarter: 91,
	year: 365,
}

/**
 * Longest custom range accepted.
 *
 * Two years, because GA4 event-level retention tops out at 14 months on most properties and Vercel
 * Web Analytics at 12 to 24 depending on plan — beyond that both sources return silence that would
 * read as a collapse. The cap also bounds the cost of a single request.
 */
export const MAX_CUSTOM_RANGE_DAYS = 730

/**
 * Resolve a range key into concrete dates, anchored to `timezone` and ending today.
 *
 * @param key - week, quarter or year
 * @param timezone - IANA timezone of the GA4 property this range will be queried against
 * @param now - injectable clock, so tests are deterministic
 */
export function resolveRange(key: Exclude<RangeKey, 'custom'>, timezone: string, now: Date = new Date()): DateRange {
	const end = formatInTimeZone(now, timezone)
	const start = shiftDays(end, -(RANGE_DAYS[key] - 1))
	return { key, start, end, timezone }
}

/**
 * The equivalent range immediately before `range`, for period-over-period comparison.
 *
 * A bare count answers "how many", which on its own is not actionable; the comparison is what
 * tells someone whether to do anything.
 */
export function previousRange(range: DateRange): DateRange {
	const span = daysBetween(range.start, range.end)
	return {
		key: range.key,
		start: shiftDays(range.start, -span),
		end: shiftDays(range.end, -span),
		timezone: range.timezone,
	}
}

/**
 * The trailing dates within a range whose GA4 figures are not yet settled.
 * Returns an empty array when the range ends before the lag window.
 */
export function provisionalDates(range: DateRange, now: Date = new Date()): string[] {
	const today = formatInTimeZone(now, range.timezone)
	const dates: string[] = []

	for (let i = 0; i < GA4_PROCESSING_LAG_DAYS; i += 1) {
		const date = shiftDays(today, -i)
		if (date >= range.start && date <= range.end) dates.push(date)
	}

	return dates.sort()
}

/**
 * Notice text when a range includes days GA4 has not finished processing, or `null` when it does not.
 * Without this a Monday-morning glance at "this week" reads the trailing dip as a real drop.
 */
export function provisionalNotice(range: DateRange, now: Date = new Date()): string | null {
	const dates = provisionalDates(range, now)
	if (dates.length === 0) return null

	const from = dates[0]
	return `GA4 has not finished processing ${from} onwards; those figures are provisional and will rise.`
}

/** Why a custom range was refused, in words a reader can act on. */
export type CustomRangeError = string

/**
 * Build a range from explicit dates, or explain why they cannot be used.
 *
 * Validated here rather than at the handler because the same rules apply wherever a range comes
 * from, and because a bad range must never reach GA4 as a silently different query — an inverted
 * start and end returns an empty report, which renders as a site with no traffic.
 *
 * @param start - inclusive ISO date, YYYY-MM-DD
 * @param end - inclusive ISO date
 * @param timezone - IANA timezone of the property, so "today" means today there
 * @param now - injectable clock
 */
export function resolveCustomRange(
	start: string,
	end: string,
	timezone: string,
	now: Date = new Date(),
): { range: DateRange } | { error: CustomRangeError } {
	const ISO = /^\d{4}-\d{2}-\d{2}$/
	if (!ISO.test(start) || !ISO.test(end)) {
		return { error: 'Dates must be written as YYYY-MM-DD.' }
	}

	const startMs = Date.parse(`${start}T00:00:00Z`)
	const endMs = Date.parse(`${end}T00:00:00Z`)
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		return { error: 'That is not a real date.' }
	}

	if (endMs < startMs) {
		return { error: 'The end date is before the start date.' }
	}

	// "Today" in the property's timezone, not the reader's. A Studio open in London asking a
	// New York property for today would otherwise be refused for half the day.
	const today = formatInTimeZone(now, timezone)
	if (end > today) {
		return { error: `The end date is in the future. The latest data available is ${today}.` }
	}

	const days = Math.round((endMs - startMs) / 86400000) + 1
	if (days > MAX_CUSTOM_RANGE_DAYS) {
		return { error: `Ranges are limited to ${MAX_CUSTOM_RANGE_DAYS} days. Both sources stop returning data well before that.` }
	}

	return { range: { key: 'custom', start, end, timezone } }
}
