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
	total: number
	/** Distinct visitors over the whole range. Not a sum of the daily figures — visitors dedupe. */
	visitors: number
}

/** A Vercel client bound to one project. */
export interface VercelClient {
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

		const response = await fetch(`${API_BASE}/${path}?${params.toString()}`, {
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
				query<{ data?: AggregateRow[] }>('visits/aggregate', {
					since: start,
					until: end,
					by: granularityFor(start, end),
					limit: '100',
				}).catch((e: Error) => {
					// The series is supplementary — it feeds sparklines, not the headline figure.
					// Losing it must not cost the totals, which is what the panel actually compares.
					console.error('Visitor insights: Vercel series unavailable:', e.message)
					return { data: [] as AggregateRow[] }
				}),
			])

			const byDate: Record<string, number> = {}
			for (const row of series.data ?? []) {
				if (!row.timestamp) continue
				byDate[row.timestamp.slice(0, 10)] = row.pageviews ?? 0
			}

			return {
				byDate,
				total: totals.data?.pageviews ?? 0,
				visitors: totals.data?.visitors ?? 0,
			}
		},
	}
}
