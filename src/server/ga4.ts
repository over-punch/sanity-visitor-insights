/**
 * GA4 Data API client.
 *
 * Only `runReport` and `batchRunReports` are used. `runFunnelReport` is deliberately not called:
 * it is an alpha surface with its own stricter quota, and it returns step-conversion marginals
 * rather than observed paths — drawing a flow diagram from it would imply co-occurrence that was
 * never measured. The journey report approximates instead, and says so.
 */

import { getAccessToken, type ServiceAccountKey } from './googleAuth'

const DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta'

/**
 * Funnels live on the alpha surface only.
 *
 * `runFunnelReport` has never been promoted past v1alpha, and Google documents it as subject to
 * breaking change. It is worth the risk because it is the only endpoint that reports an ORDERED,
 * PER-USER sequence: a closed funnel by default, where a user must have entered at step one and
 * each later step is conditional on the earlier ones having happened for that same person. Every
 * other approach here counts steps independently and cannot say anyone actually walked the path.
 *
 * It also draws on a separate quota bucket from the core reports, so exhausting one does not
 * exhaust the other.
 */
const DATA_API_ALPHA = 'https://analyticsdata.googleapis.com/v1alpha'

/** A GA4 report request, narrowed to the fields this package sets. */
export interface Ga4ReportRequest {
	dimensions?: Array<{ name: string }>
	metrics?: Array<{ name: string }>
	dateRanges: Array<{ startDate: string; endDate: string }>
	dimensionFilter?: unknown
	orderBys?: unknown
	limit?: number
	keepEmptyRows?: boolean
	/**
	 * Ask GA4 for aggregate totals across ALL rows, not just the ones returned.
	 *
	 * Needed wherever a share is computed against a limited report: summing the returned rows gives
	 * the top-N subtotal, so every share divided by it is inflated. GA4 returns these separately
	 * from the row set, which is exactly what makes them safe as a denominator.
	 */
	metricAggregations?: Array<'TOTAL' | 'MINIMUM' | 'MAXIMUM' | 'COUNT'>
}

/** A parsed report row: dimension values and metric values, positionally aligned to the request. */
export interface Ga4Row {
	dimensions: string[]
	metrics: number[]
}

/** A parsed GA4 report. */
export interface Ga4Report {
	rows: Ga4Row[]
	/** True when GA4 withheld rows for privacy thresholding — totals are then incomplete. */
	thresholded: boolean
	/** True when GA4 answered from a sample rather than the full data set. */
	sampled: boolean
	/** Total row count GA4 reports, which may exceed rows returned when a limit applied. */
	rowCount: number
	/**
	 * First metric's total across every row GA4 held, present only when metricAggregations asked
	 * for it. Undefined means "not requested", never zero — a caller must not read an absent total
	 * as an empty property.
	 */
	metricTotal?: number
	/**
	 * The property's configured timezone, as GA4 reports it. Worth capturing because every range
	 * is anchored to the timezone in site config, and a mismatch silently shifts day boundaries.
	 */
	timeZone?: string
}

/** Raw Data API response shape, narrowed to what is read here. */
interface RawReport {
	rows?: Array<{
		dimensionValues?: Array<{ value?: string }>
		metricValues?: Array<{ value?: string }>
	}>
	rowCount?: number
	totals?: Array<{ metricValues?: Array<{ value?: string }> }>
	metadata?: { subjectToThresholding?: boolean; samplingMetadatas?: unknown[]; timeZone?: string }
	propertyQuota?: unknown
}

/**
 * Coerce a GA4 metric cell to a number.
 *
 * The Data API returns every value as a string, and returns an empty string for suppressed cells.
 * `Number('')` is 0, which would turn a withheld row into a real-looking zero — so empty is
 * treated as NaN and filtered by the caller rather than silently becoming a data point.
 */
function toMetricNumber(raw: string | undefined): number {
	if (raw === undefined || raw === '') return Number.NaN
	const parsed = Number(raw)
	return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** Parse a raw Data API report into the shape the reports consume. */
function parseReport(raw: RawReport): Ga4Report {
	const rows: Ga4Row[] = (raw.rows ?? []).map((row) => ({
		dimensions: (row.dimensionValues ?? []).map((d) => d.value ?? ''),
		metrics: (row.metricValues ?? []).map((m) => toMetricNumber(m.value)),
	}))

	return {
		rows,
		thresholded: raw.metadata?.subjectToThresholding === true,
		sampled: Array.isArray(raw.metadata?.samplingMetadatas) && raw.metadata.samplingMetadatas.length > 0,
		rowCount: raw.rowCount ?? rows.length,
		// Left undefined rather than NaN when GA4 returned no totals block, so a caller can tell
		// "not requested" from a real figure. toMetricNumber yields NaN for absent, which would
		// otherwise propagate into a share as a silent wrong answer.
		metricTotal: (() => {
			const parsed = toMetricNumber(raw.totals?.[0]?.metricValues?.[0]?.value)
			return Number.isFinite(parsed) ? parsed : undefined
		})(),
		timeZone: raw.metadata?.timeZone,
	}
}

/** Raw funnel response, narrowed to what is read here. */
interface RawFunnelReport {
	funnelTable?: {
		dimensionHeaders?: Array<{ name?: string }>
		metricHeaders?: Array<{ name?: string }>
		rows?: Array<{
			dimensionValues?: Array<{ value?: string }>
			metricValues?: Array<{ value?: string }>
		}>
		metadata?: { samplingMetadatas?: unknown[] }
	}
}

/**
 * Parse a funnel response by HEADER NAME, never by position.
 *
 * GA4 returns dimensionHeaders and metricHeaders describing its own row layout, and that layout
 * changes with the request — adding a funnelBreakdown inserts a dimension, and the metric set is
 * not contractually ordered. Reading metricValues[0] and hoping is the same habit that shipped a
 * query for an `exits` metric GA4 has never had. Looking the indices up costs nothing and cannot
 * silently drift.
 *
 * Exported so the header-index logic can be tested directly. Reaching it through the client
 * would mean faking a signed service-account token to get past getAccessToken, which tests the
 * wrong thing.
 */
export function parseFunnelReport(raw: RawFunnelReport): Ga4FunnelReport {
	const table = raw.funnelTable
	if (!table) return { steps: [], sampled: false }

	const stepNameAt = (table.dimensionHeaders ?? []).findIndex((h) => h.name === 'funnelStepName')
	const metricIndex = (name: string) => (table.metricHeaders ?? []).findIndex((h) => h.name === name)

	const usersAt = metricIndex('activeUsers')
	const completionAt = metricIndex('funnelStepCompletionRate')
	const abandonmentsAt = metricIndex('funnelStepAbandonments')

	// Without a breakdown there is one row per step. With one, GA4 adds a RESERVED_TOTAL row per
	// step alongside the per-value rows; taking only totals keeps this correct either way.
	const breakdownAt = (table.dimensionHeaders ?? []).findIndex((h) => h.name !== 'funnelStepName')

	const steps: Ga4FunnelRow[] = []
	for (const row of table.rows ?? []) {
		if (stepNameAt < 0) continue
		if (breakdownAt >= 0 && row.dimensionValues?.[breakdownAt]?.value !== 'RESERVED_TOTAL') continue

		const users = usersAt >= 0 ? toMetricNumber(row.metricValues?.[usersAt]?.value) : Number.NaN
		if (!Number.isFinite(users)) continue

		const completion = completionAt >= 0 ? toMetricNumber(row.metricValues?.[completionAt]?.value) : Number.NaN
		const abandonments = abandonmentsAt >= 0 ? toMetricNumber(row.metricValues?.[abandonmentsAt]?.value) : Number.NaN

		steps.push({
			// GA4 prefixes step names with an ordinal, "1. Landed". The array already carries the
			// order, so the prefix is duplication in the label.
			name: (row.dimensionValues?.[stepNameAt]?.value ?? '').replace(/^\d+\.\s*/, ''),
			activeUsers: users,
			completionRate: Number.isFinite(completion) ? completion : null,
			abandonments: Number.isFinite(abandonments) ? abandonments : null,
		})
	}

	return {
		steps,
		sampled: Array.isArray(table.metadata?.samplingMetadatas) && table.metadata.samplingMetadatas.length > 0,
	}
}

/** One step of a funnel: a display name and the event that evidences it. */
export interface Ga4FunnelStep {
	name: string
	/** Any of these event names satisfies the step. */
	eventNames: readonly string[]
}

/** One step as GA4 answered it. */
export interface Ga4FunnelRow {
	/** Step name, with GA4's "1. " ordinal prefix stripped. */
	name: string
	/** Distinct users who reached this step having completed the earlier ones. */
	activeUsers: number
	/** Share of the previous step's users who continued, as GA4 computed it. */
	completionRate: number | null
	/** Users who reached this step and went no further. */
	abandonments: number | null
}

/** A parsed funnel report. */
export interface Ga4FunnelReport {
	steps: Ga4FunnelRow[]
	sampled: boolean
}

/** A GA4 client bound to one property. */
export interface Ga4Client {
	runReport(request: Ga4ReportRequest): Promise<Ga4Report>
	batchRunReports(requests: Ga4ReportRequest[]): Promise<Ga4Report[]>
	/**
	 * Run an ordered, closed funnel. Rejects like any other call; the caller decides whether to
	 * fall back, because a funnel failing is not a reason to show no journey at all.
	 */
	runFunnelReport(steps: readonly Ga4FunnelStep[], range: { startDate: string; endDate: string }): Promise<Ga4FunnelReport>
}

/** Options narrowing what a client will report on. */
export interface Ga4ClientOptions {
	/**
	 * Restrict every report to these hostnames.
	 *
	 * Applied here rather than at each call site on purpose. A GA4 property is not necessarily one
	 * website — Darden's also receives an unrelated business — and a filter that each report has to
	 * remember is a filter some report will forget. Forgetting it does not fail; it silently adds
	 * two businesses together and calls the total one site.
	 */
	hostnames?: readonly string[]
}

/**
 * A dimension filter restricting a report to a set of hostnames.
 *
 * @param hostnames - bare hosts, e.g. `www.dardenstudio.com`
 */
export function hostnameFilter(hostnames: readonly string[]): unknown {
	return {
		filter: {
			fieldName: 'hostName',
			inListFilter: { values: [...hostnames] },
		},
	}
}

/**
 * Combine dimension filters with AND, dropping the ones that are absent.
 *
 * Returns undefined rather than an empty group when nothing is left, because GA4 rejects an
 * andGroup with no expressions.
 */
export function andFilters(...filters: Array<unknown | undefined>): unknown | undefined {
	const present = filters.filter((f) => f !== undefined && f !== null)
	if (present.length === 0) return undefined
	if (present.length === 1) return present[0]
	return { andGroup: { expressions: present } }
}

/**
 * Build a GA4 client for one property.
 *
 * @param propertyId - numeric GA4 property id
 * @param key - service-account key with Viewer on that property
 * @param options - client-wide narrowing applied to every request
 */
export function createGa4Client(propertyId: string, key: ServiceAccountKey, options: Ga4ClientOptions = {}): Ga4Client {
	const hosts = options.hostnames && options.hostnames.length > 0 ? options.hostnames : null
	const hostFilter = hosts ? hostnameFilter(hosts) : undefined

	/** AND the client's hostname filter into a request's own filter, if there is one of each. */
	function narrow(request: Ga4ReportRequest): Ga4ReportRequest {
		if (!hostFilter) return request
		return { ...request, dimensionFilter: andFilters(request.dimensionFilter, hostFilter) }
	}

	async function post<T>(path: string, body: unknown, base: string = DATA_API_BASE): Promise<T> {
		const token = await getAccessToken(key)

		const response = await fetch(`${base}/properties/${propertyId}:${path}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			// GA4 error bodies can echo the request; keep only the status for the caller's log.
			throw new Error(`GA4 ${path} failed with ${response.status}`)
		}

		return (await response.json()) as T
	}

	return {
		async runReport(request) {
			const raw = await post<RawReport>('runReport', narrow(request))
			return parseReport(raw)
		},

		/**
		 * Run several reports in one call. Preferred over parallel runReport calls: it is one
		 * quota-charged request and one round trip rather than N of each.
		 */
		async batchRunReports(requests) {
			if (requests.length === 0) return []

			const raw = await post<{ reports?: RawReport[] }>('batchRunReports', { requests: requests.map(narrow) })
			return (raw.reports ?? []).map(parseReport)
		},

		async runFunnelReport(steps, range) {
			// RunFunnelReportRequest takes only dateRanges, funnel and funnelBreakdown — there is no
			// top-level dimension filter to hang the hostname on. A step's filterExpression does
			// accept a funnelFieldFilter though, so the host is ANDed into every step instead.
			const hostStepFilter = hosts
				? { funnelFieldFilter: { fieldName: 'hostName', inListFilter: { values: [...hosts] } } }
				: null

			const body = {
				dateRanges: [range],
				funnel: {
					steps: steps.map((step) => {
						// One event satisfies the step directly; several go in an orGroup, which is
						// how GA4 expresses "any of these" — TDF maps five tester events onto one rung.
						const eventExpression = step.eventNames.length === 1
							? { funnelEventFilter: { eventName: step.eventNames[0] } }
							: {
								orGroup: {
									expressions: step.eventNames.map((eventName) => ({
										funnelEventFilter: { eventName },
									})),
								},
							}

						return {
							name: step.name,
							filterExpression: hostStepFilter
								? { andGroup: { expressions: [eventExpression, hostStepFilter] } }
								: eventExpression,
						}
					}),
				},
			}

			const raw = await post<RawFunnelReport>('runFunnelReport', body, DATA_API_ALPHA)
			return parseFunnelReport(raw)
		},
	}
}

/** Build a dimension filter matching a single event name. */
export function eventNameFilter(eventName: string): unknown {
	return {
		filter: {
			fieldName: 'eventName',
			stringFilter: { matchType: 'EXACT', value: eventName },
		},
	}
}

/**
 * Build a dimension filter matching any of several event names.
 * Falls back to a single exact match when only one name is given, which is the common case.
 */
export function eventNamesFilter(eventNames: readonly string[]): unknown {
	if (eventNames.length === 1) return eventNameFilter(eventNames[0] as string)
	return {
		filter: {
			fieldName: 'eventName',
			inListFilter: { values: [...eventNames] },
		},
	}
}

/** Sum a report's first metric across all rows, ignoring suppressed cells. */
export function sumFirstMetric(report: Ga4Report): number {
	return report.rows.reduce((total, row) => {
		const value = row.metrics[0]
		return value !== undefined && Number.isFinite(value) ? total + value : total
	}, 0)
}
