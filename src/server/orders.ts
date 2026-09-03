/**
 * Order figures from Sanity — the only source in this tool that is not lossy.
 *
 * Orders on these sites carry customer names, emails and postal addresses. Joining that to
 * behavioural analytics would turn aggregate statistics into personal-data processing and put the
 * GA4 property at risk under Google's terms, so no query in this file may project a PII field.
 * The projections below are allow-lists, not conveniences: every GROQ query here names the exact
 * fields it returns, and none of them is a customer identifier.
 *
 * Revenue used to be excluded on the grounds that this package reports behaviour and the sales
 * portal reports sales. That was the wrong line to draw. An order total is not a customer field,
 * and without it a $30 web licence and a $400 multi-seat desktop licence are the same integer —
 * so nothing in the tool could be ranked by what it is worth: not a channel, not a family, not a
 * funnel step. The PII rule is unchanged; only the value crosses over, and only when a site names
 * the field it lives in.
 *
 * These figures also matter disproportionately because they survive what GA4 does not. Consent
 * refusal, ad-blocking, a misconfigured data filter and the 24 August collapse all leave the order
 * documents untouched. When GA4 was reporting a fifth of reality, this was still complete.
 */

import { zonedDayEndUtc, zonedDayStartUtc } from '../core/ranges'

/** Fields safe to read from an order. Nothing here identifies a person. */
const SAFE_ORDER_FIELDS = ['_createdAt']

/** Default field holding an order's status, overridable per site. */
const DEFAULT_STATUS_FIELD = 'orderStatus'

/** Status recorded for an order whose status field is empty or missing. */
export const UNKNOWN_STATUS = '(no status)'

/** How a site describes its orders. Mirrors the fields of OrdersConfig this module needs. */
export interface OrderQueryOptions {
	documentType: string
	/** Inclusive ISO date, in `timezone`. */
	start: string
	/** Inclusive ISO date, in `timezone`. */
	end: string
	/** IANA timezone the dates are expressed in — the GA4 property's, so all sources agree. */
	timezone: string
	excludeFilter?: string
	statusField?: string
	countedStatuses?: readonly string[]
	totalField?: string
}

/**
 * Build the query options for a site and a resolved range.
 *
 * A single place where config meets range, so the three call sites cannot drift on which fields
 * they pass — the status allow-list and the total field were both easy to forget one call at a
 * time, and forgetting them degrades silently rather than failing.
 *
 * @param orders - the site's orders config
 * @param range - the resolved range, carrying its own timezone
 */
export function orderQueryOptions(
	orders: {
		documentType: string
		excludeFilter?: string
		statusField?: string
		countedStatuses?: readonly string[]
		totalField?: string
	},
	range: { start: string; end: string; timezone: string },
): OrderQueryOptions {
	return {
		documentType: orders.documentType,
		start: range.start,
		end: range.end,
		timezone: range.timezone,
		excludeFilter: orders.excludeFilter,
		statusField: orders.statusField,
		countedStatuses: orders.countedStatuses,
		totalField: orders.totalField,
	}
}

/** Daily order figures across a range. */
export interface OrderCounts {
	/** Counted orders per calendar date, in the property timezone. */
	byDate: Record<string, number>
	/** Counted orders in the range. */
	total: number
	/**
	 * Revenue across counted orders, or null when the site names no total field.
	 * Null and zero are different answers and must not be rendered alike.
	 */
	revenue: number | null
	/** Revenue per calendar date, or null when the site names no total field. */
	revenueByDate: Record<string, number> | null
	/**
	 * How many orders carried each status, before any status filtering.
	 *
	 * Always reported, even when nothing is filtered on it: an operator cannot configure
	 * `countedStatuses` without first seeing what vocabulary their own orders use, and this is the
	 * only place that vocabulary is visible.
	 */
	byStatus: Record<string, number>
	/** Orders dropped by `countedStatuses`. Zero when no allow-list is configured. */
	excludedByStatus: number
	/** Whether a status allow-list was applied at all. */
	statusFiltered: boolean
}

/** Orders and revenue attributable to a typeface. */
export interface TypefaceOrderCounts {
	/**
	 * Typeface title to the number of distinct ORDERS containing it.
	 *
	 * Distinct orders, not line references: a three-family order used to add 3 here while adding 1
	 * to the range total, so summing this map and comparing it against the order count did not
	 * reconcile and nothing explained why.
	 */
	byTypeface: Record<string, number>
	/**
	 * Revenue attributed to each typeface, or null when no total field is configured.
	 *
	 * An order's total is split evenly across the distinct families on it. The order documents do
	 * not carry per-family line values, so this is an apportionment rather than a measurement —
	 * attributing the full total to each family instead would triple-count a three-family order.
	 * Reported as approximate upstream for that reason.
	 */
	revenueByTypeface: Record<string, number> | null
	/** Distinct orders that resolved to at least one typeface. */
	orders: number
}

/** What this module needs from a Sanity client — kept minimal so it is trivial to stub in tests. */
export interface SanityQueryClient {
	fetch<T>(query: string, params?: Record<string, unknown>): Promise<T>
}

/**
 * Build a GROQ filter for orders in a date range.
 *
 * `excludeFilter` lets a site drop non-typeface orders, e.g. merch-only orders on Darden, which
 * would otherwise inflate a family's apparent purchase count.
 */
function orderFilter(documentType: string, excludeFilter?: string): string {
	const clauses = [
		`_type == $documentType`,
		`_createdAt >= $start`,
		`_createdAt < $end`,
	]
	if (excludeFilter) clauses.push(`(${excludeFilter})`)
	return clauses.join(' && ')
}

/**
 * Bind the query parameters shared by every order query.
 *
 * The bounds are the UTC instants at which the range's first and last calendar days begin and end
 * *in the property's timezone*, so this query covers the same window GA4 was asked for. The end is
 * exclusive, which is why the filter uses `<` rather than `<=`.
 */
function orderParams(options: OrderQueryOptions): Record<string, unknown> {
	return {
		documentType: options.documentType,
		start: zonedDayStartUtc(options.start, options.timezone),
		end: zonedDayEndUtc(options.end, options.timezone),
	}
}

/** Project the safe fields plus whichever optional ones this site names. */
function projection(options: OrderQueryOptions, extra: string[] = []): string {
	const fields = [...SAFE_ORDER_FIELDS, ...extra]
	fields.push(`"status": ${options.statusField ?? DEFAULT_STATUS_FIELD}`)
	if (options.totalField) fields.push(`"orderTotal": ${options.totalField}`)
	return `{ ${fields.join(', ')} }`
}

/** One order as the safe projection returns it. */
interface SafeOrder {
	_createdAt: string
	status?: string | null
	orderTotal?: number | null
}

/** Normalise a status value into the key used for the breakdown. */
function statusKey(raw: string | null | undefined): string {
	const trimmed = typeof raw === 'string' ? raw.trim() : ''
	return trimmed === '' ? UNKNOWN_STATUS : trimmed
}

/**
 * Whether an order counts as a real sale under this site's allow-list.
 *
 * Case-insensitive, because a status vocabulary written by hand in a Studio rarely stays
 * consistent about capitalisation and a near-miss would silently drop a genuine order.
 */
function isCounted(status: string, countedStatuses?: readonly string[]): boolean {
	if (!countedStatuses || countedStatuses.length === 0) return true
	const normalised = status.toLowerCase()
	return countedStatuses.some((allowed) => allowed.toLowerCase() === normalised)
}

/** A finite number, or null. Guards against a total field holding a string or null in Sanity. */
function money(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Count orders and revenue per day across a range.
 *
 * @param client - a Sanity client
 * @param options - the site's order description and the resolved range
 */
export async function countOrders(
	client: SanityQueryClient,
	options: OrderQueryOptions,
): Promise<OrderCounts> {
	const query = `*[${orderFilter(options.documentType, options.excludeFilter)}]${projection(options)}`
	const orders = await client.fetch<SafeOrder[]>(query, orderParams(options))

	const byDate: Record<string, number> = {}
	const revenueByDate: Record<string, number> = {}
	const byStatus: Record<string, number> = {}
	let total = 0
	let revenue = 0
	let excludedByStatus = 0

	for (const order of orders) {
		const status = statusKey(order.status)
		byStatus[status] = (byStatus[status] ?? 0) + 1

		if (!isCounted(status, options.countedStatuses)) {
			excludedByStatus += 1
			continue
		}

		// Bucketed by the date the order carries in UTC. The range bounds already align to the
		// property timezone, so this only affects which day inside the range an order lands on.
		const date = order._createdAt.slice(0, 10)
		byDate[date] = (byDate[date] ?? 0) + 1
		total += 1

		const value = money(order.orderTotal)
		if (value !== null) {
			revenue += value
			revenueByDate[date] = (revenueByDate[date] ?? 0) + value
		}
	}

	return {
		byDate,
		total,
		revenue: options.totalField ? revenue : null,
		revenueByDate: options.totalField ? revenueByDate : null,
		byStatus,
		excludedByStatus,
		statusFiltered: Boolean(options.countedStatuses && options.countedStatuses.length > 0),
	}
}

/**
 * Count orders and revenue per typeface across a range.
 *
 * Returns null when the site has no usable typeface field on orders, rather than guessing — an
 * absent join is reported as unavailable upstream, not as zero purchases.
 *
 * @param typefacesField - the order field holding typeface references, or null when absent
 */
export async function countOrdersByTypeface(
	client: SanityQueryClient,
	options: OrderQueryOptions,
	typefacesField: string | null,
): Promise<TypefaceOrderCounts | null> {
	if (!typefacesField) return null

	// Dereferences only the typeface title — never the order's customer fields.
	const query = `*[${orderFilter(options.documentType, options.excludeFilter)}]${projection(options, [
		`"typefaces": ${typefacesField}[]->{ title }`,
	])}`

	const orders = await client.fetch<Array<SafeOrder & { typefaces?: Array<{ title?: string } | null> | null }>>(
		query,
		orderParams(options),
	)

	const byTypeface: Record<string, number> = {}
	const revenueByTypeface: Record<string, number> = {}
	let counted = 0

	for (const order of orders) {
		if (!isCounted(statusKey(order.status), options.countedStatuses)) continue

		// Deduped per order. A family referenced twice on one order — two licence tiers, say — is
		// one order for that family, not two.
		const families = new Set<string>()
		for (const typeface of order.typefaces ?? []) {
			const title = typeface?.title
			if (title) families.add(title)
		}
		if (families.size === 0) continue

		counted += 1
		const value = money(order.orderTotal)
		const share = value !== null ? value / families.size : null

		for (const family of families) {
			byTypeface[family] = (byTypeface[family] ?? 0) + 1
			if (share !== null) revenueByTypeface[family] = (revenueByTypeface[family] ?? 0) + share
		}
	}

	return {
		byTypeface,
		revenueByTypeface: options.totalField ? revenueByTypeface : null,
		orders: counted,
	}
}
