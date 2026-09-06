import { fetchWithTimeout } from './fetchWithTimeout'
/**
 * Vercel Web Analytics client.
 *
 * Uses the documented Web Analytics query API under `/v1/query/web-analytics/visits/*`. An earlier
 * version of this file guessed at `/v1/web-analytics/timeseries`, which does not exist and returned
 * 404 for every project — indistinguishable, from the outside, from the feature being switched off.
 * That mistake is why `unavailable` carries a reason: a 404 here now surfaces as a source error to
 * be investigated rather than as an absence of traffic.
 *
 * Vercel is counted purely as a second, cookieless pageview measurement. It is never treated as
 * ground truth, and never subtracted from a GA4 session count — those are different units.
 *
 * Note the API defaults to the production environment only, which is what the reports want.
 */

const API_BASE = 'https://api.vercel.com/v1/query/web-analytics'

/** Daily pageview counts, keyed by ISO date. */
export interface VercelPageviews {
	byDate: Record<string, number>
	total: number | null
	/** Distinct visitors over the whole range. Not a sum of the daily figures — visitors dedupe. */
	visitors: number | null
	/** True when the series is day-bucketed. False for the coarse monthly fallback. */
	daily?: boolean
	/**
	 * How many windows of the daily series failed to fetch.
	 *
	 * Above zero, `byDate` has a hole the size of a whole window while `total` still spans the range,
	 * so the two must not be differenced and the chart must not draw the hole as an outage.
	 */
	incompleteWindows?: number
}

/** A Vercel client bound to one project. */
export interface VercelClient {
	/**
	 * Vercel buckets and filters by UTC day. The other sources are anchored to the property
	 * timezone, so a bucket can straddle two of its days — bounded at one day, and not fixable
	 * without hourly granularity from the API. Stated in `byDate`'s own docs rather than hidden
	 * behind a conversion that relabels the error instead of removing it.
	 *
	 * @param start - first day, ISO
	 * @param end - last day, ISO, inclusive
	 */
	pageviews(start: string, end: string): Promise<VercelPageviews>
}

/**
 * Pick a time granularity the aggregate endpoint will accept.
 *
 * It rejects any grouping that would return more than 62 buckets — a quarter or a year grouped by
 * day is a 400, not an empty result. Stepping the granularity up keeps long ranges working instead
 * of failing outright, which is what the year view needs.
 */
export function granularityFor(start: string, end: string): 'day' | 'week' | 'month' {
	const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
	// Measured against the live API: day is capped at 62 days, week at 26 weeks. Both limits are
	// on buckets returned, and exceeding either is a 400 rather than a truncated result.
	if (days <= 62) return 'day'
	if (days <= 26 * 7) return 'week'
	return 'month'
}

/**
 * Split a range into windows the aggregate endpoint will serve by DAY.
 *
 * The 62-bucket cap is per request, not per range — so a quarter fetched in two calls comes back
 * daily, and a year in six. Stepping the granularity up instead was the cheap answer, and it cost
 * the tool its subject: past 62 days every `vercelPageviews` became null, so the coverage row, the
 * incident detector, the missed-pageviews total and both disagreement columns all went blank on
 * Quarter and Year — the ranges a reader opens precisely to find when a gap opened.
 *
 * Capped at six windows. Beyond that the request count stops being worth the daily resolution, and
 * the caller falls back to a single coarser call.
 *
 * @param start - ISO first day
 * @param end - ISO last day, inclusive
 */
export function dailyWindows(start: string, end: string): Array<{ start: string; end: string }> {
	const MAX_DAYS = 62
	const MAX_WINDOWS = 6
	const first = Date.parse(`${start}T00:00:00Z`)
	const last = Date.parse(`${end}T00:00:00Z`)
	// Malformed input is not the same as "too long", and both returned an empty array — so the
	// caller fell through to `granularityFor`, which computes Math.round(NaN) + 1 and silently
	// answers 'month'. A bad date became a coarse chart rather than an error anyone could see.
	if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
		throw new RangeError(`Vercel series requested for an invalid range: ${start} to ${end}`)
	}

	const days = Math.round((last - first) / 86_400_000) + 1
	// Too long: the caller falls back to one coarser call, which is the right answer here.
	if (days > MAX_DAYS * MAX_WINDOWS) return []

	const windows: Array<{ start: string; end: string }> = []
	for (let offset = 0; offset < days; offset += MAX_DAYS) {
		const chunkStart = first + offset * 86_400_000
		const chunkEnd = Math.min(last, chunkStart + (MAX_DAYS - 1) * 86_400_000)
		windows.push({
			start: new Date(chunkStart).toISOString().slice(0, 10),
			end: new Date(chunkEnd).toISOString().slice(0, 10),
		})
	}
	return windows
}

/** Shape of the aggregate response rows. */
interface AggregateRow {
	timestamp?: string
	pageviews?: number
	visitors?: number
}

/**
 * Build a Vercel Web Analytics client.
 *
 * @param projectId - the Vercel project id
 * @param token - a Vercel API token with read access to that project
 * @param teamId - team scope, required when the project belongs to a team
 */
export function createVercelClient(projectId: string, token: string, teamId?: string): VercelClient {
	async function query<T>(path: string, extra: Record<string, string>): Promise<T> {
		const params = new URLSearchParams({ projectId, ...extra })
		if (teamId) params.set('teamId', teamId)

		const response = await fetchWithTimeout(`${API_BASE}/${path}?${params.toString()}`, {
			headers: { Authorization: `Bearer ${token}` },
		})

		if (!response.ok) {
			// 404 here means the endpoint or project is wrong, or Web Analytics is not enabled —
			// the status is the only useful detail, and the body can echo the request.
			throw new Error(`Vercel Web Analytics ${path} failed with ${response.status}`)
		}

		return (await response.json()) as T
	}

	return {
		async pageviews(start, end) {

			// Two calls on purpose. The count endpoint gives range totals with visitors deduped
			// across the whole window; summing the daily rows would overcount visitors, because a
			// person returning on three days is three daily visitors but one range visitor.
			// It also has no range limit, unlike the aggregate below.
			const [totals, series] = await Promise.all([
				query<{ data?: { pageviews?: number; visitors?: number } }>('visits/count', {
					since: start,
					until: end,
				}),
				// One call per window, so a long range still comes back by day. A single window is the
				// short-range case and behaves exactly as before.
				(async () => {
					const windows = dailyWindows(start, end)
					const requests = windows.length > 0
						? windows.map((w) => ({ since: w.start, until: w.end, by: 'day' as const }))
						: [{ since: start, until: end, by: granularityFor(start, end) }]

					const parts = await Promise.all(requests.map((params) =>
						query<{ data?: AggregateRow[] }>('visits/aggregate', { ...params, limit: '100' })
							.then((part) => ({ ...part, failed: false }))
							.catch((e: Error) => {
								// The series is supplementary — it feeds the chart, not the headline
								// figure. Losing it must not cost the totals, which is what the panel
								// actually compares.
								console.error('Visitor insights: Vercel series window unavailable:', e.message)
								return { data: [] as AggregateRow[], failed: true }
							}),
					))
					/*
					 * A failed window is REPORTED, not silently absent.
					 *
					 * One window of six failing on a year leaves 303 of 365 days — still above the 70%
					 * bar that decides whether the series counts as daily — so the chart drew a 62-day
					 * hole indistinguishable from a real two-month outage, on the panel built to tell
					 * those apart. This is the same class of bug the whole-series case already fixed,
					 * reintroduced at window granularity by the chunking.
					 */
					return {
						data: parts.flatMap((part) => part.data ?? []),
						incompleteWindows: parts.filter((part) => part.failed).length,
						// Whether these buckets are days at all. The coarse fallback returns months.
						daily: windows.length > 0,
					}
				})(),
			])

			const byDate: Record<string, number> = {}
			for (const row of series.data ?? []) {
				if (!row.timestamp) continue
				/*
				 * Labelled by the bucket's own UTC date, which is the closest available answer.
				 *
				 * A previous release converted this instant into the property's timezone, on the
				 * reasoning that every other source is anchored there. That is wrong, and worse than
				 * what it replaced. Vercel buckets by UTC DAY; converting the bucket's start instant
				 * names the local day the bucket BEGAN on, and for any zone behind UTC that is the
				 * minority of it — a Los Angeles bucket spans 7 hours of one local day and 17 of the
				 * next, and the conversion picked the 7. The UTC date is the majority day for every
				 * zone within 12 hours of UTC, which is all of them.
				 *
				 * Genuinely re-bucketing would need hourly granularity from the API, which is not
				 * something to assume. Until then the seam is real, bounded at one day, and stated
				 * rather than papered over with a conversion that moves the error rather than
				 * removing it.
				 */
				const day = row.timestamp.slice(0, 10)
				if (day < start || day > end) continue
				byDate[day] = (byDate[day] ?? 0) + (row.pageviews ?? 0)
			}

			// Pageviews SUM, so the zoned daily series is the better total: it covers exactly the
			// window GA4 was asked about, where the count endpoint's bare dates are read as UTC and
			// can start and end up to eight hours away from it. Visitors do NOT sum — a person
			// returning on three days is three daily visitors and one range visitor — so those still
			// come from the count endpoint, with the zone caveat that implies.
			const daysTotal = Object.values(byDate).reduce((sum, value) => sum + value, 0)
			/*
			 * Complete means DAILY and whole, not merely non-empty.
			 *
			 * Above the window cap the client falls back to one coarse call, and `by: 'month'` returns
			 * a handful of month-labelled buckets. Those were then summed and published as the range
			 * total — a month bucket straddling the start is dropped whole by a day comparison, one
			 * straddling the end is included whole, and `incompleteWindows` stays 0, so the very
			 * mechanism built to say "do not trust this series" reported it as sound.
			 */
			const seriesIsComplete = (series.incompleteWindows ?? 0) === 0
				&& series.daily
				&& Object.keys(byDate).length > 0

			return {
				byDate,
				// How many windows of the daily series are missing. The totals call is not chunked —
				// it has no range limit — so `total` always spans the whole range while `byDate` may
				// not, and the two feed different figures on one panel. Saying so is what lets the
				// panel avoid comparing them.
				incompleteWindows: series.incompleteWindows ?? 0,
				daily: series.daily ?? false,
				total: seriesIsComplete ? daysTotal : totals.data?.pageviews ?? null,
				// Absent is not zero. A malformed or partial response used to become ok(0) and render
				// as a measured figure — on the very panel whose job is to detect that.
				visitors: totals.data?.visitors ?? null,
			}
		},
	}
}
