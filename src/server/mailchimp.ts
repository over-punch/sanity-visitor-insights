import { fetchWithTimeout } from './fetchWithTimeout'
/**
 * Mailchimp — the audience a foundry actually owns.
 *
 * Every other source here describes people who happened to arrive. This one describes people who
 * chose to stay, and it is the only channel a foundry controls rather than rents from Google or a
 * referrer. It is also complete: a list count is not consent-gated, not ad-blockable, and not
 * subject to a data filter someone switched on.
 *
 * That completeness is why it belongs in the tool rather than being left in Mailchimp's own UI. It
 * does two things GA4 cannot:
 *
 * 1. It REPLACES a known-wrong number. Darden's `subscribe` event double-counts — GTM has a
 *    container tag for it and the direct gtag instance also sends it — and it treats an HTTP 400 as
 *    a success, which is what the provider returns for an address that is already subscribed. The
 *    site's own caveats say so. Mailchimp's member count is the truth that figure was approximating
 *    badly.
 *
 * 2. It supplies a THIRD independent estimate of GA4's capture rate. A campaign's unique subscriber
 *    clicks is a cohort whose true size is known exactly, and GA4 should see a session for each. A
 *    shortfall there that the orders-based estimate does not show is an attribution problem — a
 *    missing UTM, a redirect eating the query string — rather than a measurement one.
 *
 * No subscriber is ever read. The endpoints used here return aggregates only; nothing in this file
 * requests a member record, and nothing may be added that does.
 */

/** The subset of a Mailchimp campaign report this tool reads. Aggregates only. */
export interface MailchimpCampaign {
	id: string
	title: string
	subject: string
	/** ISO 8601 send time. */
	sentAt: string
	emailsSent: number
	/** Distinct people who opened. Apple Mail Privacy Protection inflates this; clicks do not. */
	uniqueOpens: number
	/**
	 * Distinct SUBSCRIBERS who clicked, not total clicks.
	 *
	 * This is the capture-rate cohort: one person, one expected GA4 session. `unique_clicks` counts
	 * distinct links clicked and would overstate the cohort.
	 */
	uniqueClicks: number
	unsubscribed: number
}

/** Audience size and how it moved. */
export interface MailchimpAudience {
	/** Current subscribed member count. */
	members: number
	/** Members at the start of the range, or null when the month is not covered by the API. */
	membersAtStart: number | null
}

/** What the reports need from Mailchimp. Narrow, so it is trivial to stub. */
export interface MailchimpClient {
	audience(range: { start: string; end: string }): Promise<MailchimpAudience>
	campaigns(range: { start: string; end: string }): Promise<MailchimpCampaign[]>
}

/**
 * Pull the datacenter prefix out of an API key.
 *
 * Mailchimp keys end `-us14`, and the API host is `https://us14.api.mailchimp.com`. Deriving it
 * beats asking a site to configure it separately: the two can then never disagree, and a site that
 * rotates its key into a different datacenter keeps working without a second edit.
 */
export function datacenterFromKey(apiKey: string): string | null {
	const dc = apiKey.split('-').pop()
	// A datacenter is a region code plus a number, e.g. us14, us21. Anything else means the key is
	// malformed or is an OAuth token, which does not carry one.
	return dc && /^[a-z]{2}\d+$/.test(dc) ? dc : null
}

/** Number, or 0 — used only where Mailchimp's own schema guarantees an integer. */
function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Build a Mailchimp client.
 *
 * @param apiKey - a Marketing API key; its datacenter suffix selects the host
 * @param listId - the audience to report on
 */
export function createMailchimpClient(apiKey: string, listId: string): MailchimpClient | null {
	const dc = datacenterFromKey(apiKey)
	if (!dc) return null

	const base = `https://${dc}.api.mailchimp.com/3.0`
	// Mailchimp accepts HTTP Basic with any username and the key as the password.
	const auth = `Basic ${Buffer.from(`key:${apiKey}`).toString('base64')}`

	async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
		const query = new URLSearchParams(params).toString()
		const response = await fetchWithTimeout(`${base}${path}${query ? `?${query}` : ''}`, {
			headers: { Authorization: auth },
		})

		if (!response.ok) {
			// Only the status and the path cross into the log. A Mailchimp error body can echo the
			// request, and the request carries the key.
			throw new Error(`Mailchimp ${path} failed with ${response.status}`)
		}

		return (await response.json()) as T
	}

	return {
		async audience(range) {
			const list = await get<{ stats?: { member_count?: number } }>(`/lists/${listId}`, {
				fields: 'stats.member_count',
			})

			// Growth history is monthly, so it can only anchor the start of the range to a month
			// boundary. Reported as null rather than approximated when the range does not begin on
			// one — a growth figure measured over a different window than the panel claims is worse
			// than no growth figure.
			let membersAtStart: number | null = null
			if (range.start.endsWith('-01')) {
				try {
					const month = range.start.slice(0, 7)
					const history = await get<{ existing?: number; imports?: number; optins?: number }>(
						`/lists/${listId}/growth-history/${month}`,
						{ fields: 'existing,imports,optins' },
					)
					membersAtStart = count(history.existing) + count(history.imports) + count(history.optins)
				} catch {
					// Months before the list existed 404. Absent is the honest answer.
					membersAtStart = null
				}
			}

			return { members: count(list.stats?.member_count), membersAtStart }
		},

		async campaigns(range) {
			const reports = await get<{ reports?: Array<Record<string, unknown>>; total_items?: number }>('/reports', {
				// Bounded by the range on both sides, so a panel showing one week does not pick up a
				// campaign from last year and attribute its clicks to this window.
				since_send_time: `${range.start}T00:00:00+00:00`,
				before_send_time: `${range.end}T23:59:59+00:00`,
				/*
				 * The documented maximum, and `total_items` so truncation can be SEEN.
				 *
				 * This asked for 100 and never read the count. Mailchimp's default is 10 and its
				 * maximum is 1000, so a sender past a hundred campaigns in the window silently lost
				 * the rest — dropped from the email capture estimate, whose whole claim is a cohort
				 * "whose true size is known exactly", and dropped from the timeline markers. Every
				 * other truncation in this package is reported: GA4 rows, Vercel windows, orders
				 * missing a total. This one was not even measurable.
				 */
				count: '1000',
				fields: [
					'total_items',
					'reports.id',
					'reports.campaign_title',
					'reports.subject_line',
					'reports.send_time',
					'reports.emails_sent',
					'reports.unsubscribed',
					'reports.opens.unique_opens',
					'reports.clicks.unique_subscriber_clicks',
				].join(','),
			})

			const returned = reports.reports ?? []
			// Said, not swallowed. A cohort the estimate calls "known exactly" cannot be missing rows
			// without the reader being told.
			if (typeof reports.total_items === 'number' && reports.total_items > returned.length) {
				console.error(
					`Visitor insights: Mailchimp reported ${reports.total_items} campaigns in this range and returned ${returned.length}.`,
				)
			}

			return returned.map((report) => {
				const opens = report.opens as { unique_opens?: number } | undefined
				const clicks = report.clicks as { unique_subscriber_clicks?: number } | undefined
				return {
					id: String(report.id ?? ''),
					title: String(report.campaign_title ?? 'Untitled campaign'),
					subject: String(report.subject_line ?? ''),
					sentAt: String(report.send_time ?? ''),
					emailsSent: count(report.emails_sent),
					uniqueOpens: count(opens?.unique_opens),
					uniqueClicks: count(clicks?.unique_subscriber_clicks),
					unsubscribed: count(report.unsubscribed),
				}
			})
		},
	}
}
