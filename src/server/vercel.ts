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
			const [totals, series] = await Promise.all([
				query<{ data?: { pageviews?: number; visitors?: number } }>('visits/count', {
					since: start,
					until: end,
				}),
				query<{ data?: AggregateRow[] }>('visits/aggregate', {
					since: start,
					until: end,
					by: 'day',
					limit: '100',
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
