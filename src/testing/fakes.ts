/**
 * Test doubles and fixture builders for the report layer.
 *
 * The reports are thin wrappers over three upstreams, but the reasoning inside them — which
 * absence means "unavailable" rather than zero, which ratios may be computed at all, which source
 * failure is allowed to degrade which figure — is exactly the part that silently corrupts a
 * dashboard. That reasoning needs to be exercised without credentials, so these fakes stand in for
 * GA4, Vercel and Sanity and record what they were asked.
 *
 * Exported from the package (not just used internally) so a consuming site can drive the same
 * fakes in its own integration tests before wiring real credentials.
 */

import type { Ga4Client, Ga4Report, Ga4ReportRequest, Ga4Row } from '../server/ga4'
import type { VercelClient, VercelPageviews } from '../server/vercel'
import type { SanityQueryClient } from '../server/orders'

/** Build a GA4 report fixture from plain rows. */
export function makeGa4Report(
	rows: Array<{ dimensions?: string[]; metrics: number[] }>,
	options: { thresholded?: boolean; sampled?: boolean } = {},
): Ga4Report {
	const parsed: Ga4Row[] = rows.map((row) => ({
		dimensions: row.dimensions ?? [],
		metrics: row.metrics,
	}))

	return {
		rows: parsed,
		thresholded: options.thresholded ?? false,
		sampled: options.sampled ?? false,
		rowCount: parsed.length,
	}
}

/** Shorthand for a single-metric, single-row report — the common case. */
export function makeGa4Total(total: number): Ga4Report {
	return makeGa4Report([{ metrics: [total] }])
}

/** A GA4 fake that also records what it was asked. */
export interface FakeGa4Client extends Ga4Client {
	/** Every batchRunReports call, as arrays of requests. */
	batchCalls: Ga4ReportRequest[][]
	/** Every runReport call. */
	singleCalls: Ga4ReportRequest[]
}

/** Script controlling what the GA4 fake returns. */
export interface Ga4Script {
	/** Handles batchRunReports. Receives the requests, returns one report per request. */
	batch?: (requests: Ga4ReportRequest[]) => Ga4Report[]
	/** Handles runReport. */
	single?: (request: Ga4ReportRequest) => Ga4Report
	/** When set, every call rejects with this error instead. */
	failWith?: Error
}

/**
 * Build a GA4 client fake.
 *
 * Unhandled calls return an empty report rather than throwing, so a test only has to script the
 * behaviour it actually cares about.
 */
export function createFakeGa4Client(script: Ga4Script = {}): FakeGa4Client {
	const batchCalls: Ga4ReportRequest[][] = []
	const singleCalls: Ga4ReportRequest[] = []

	return {
		batchCalls,
		singleCalls,

		async batchRunReports(requests) {
			batchCalls.push(requests)
			if (script.failWith) throw script.failWith
			if (script.batch) return script.batch(requests)
			return requests.map(() => makeGa4Report([]))
		},

		async runReport(request) {
			singleCalls.push(request)
			if (script.failWith) throw script.failWith
			if (script.single) return script.single(request)
			return makeGa4Report([])
		},
	}
}

/** Build a Vercel client fake returning a fixed total. */
export function createFakeVercelClient(
	result: VercelPageviews | Error,
): VercelClient {
	return {
		async pageviews() {
			if (result instanceof Error) throw result
			return result
		},
	}
}

/** Build a Vercel pageviews fixture. */
export function makeVercelPageviews(byDate: Record<string, number>): VercelPageviews {
	return {
		byDate,
		total: Object.values(byDate).reduce((sum, n) => sum + n, 0),
	}
}

/** A Sanity fake that also records the GROQ it was asked to run. */
export interface FakeSanityClient extends SanityQueryClient {
	/** Every query, with its params. Assert against this to prove no PII field was projected. */
	queries: Array<{ query: string; params?: Record<string, unknown> }>
}

/**
 * Build a Sanity client fake.
 *
 * @param respond - returns the documents for a given query, or throws to simulate failure
 */
export function createFakeSanityClient(respond: (query: string) => unknown): FakeSanityClient {
	const queries: Array<{ query: string; params?: Record<string, unknown> }> = []

	return {
		queries,
		async fetch<T>(query: string, params?: Record<string, unknown>): Promise<T> {
			queries.push({ query, params })
			return respond(query) as T
		},
	}
}

/** Build order documents at given dates, in the shape the safe projection returns. */
export function makeOrders(dates: string[]): Array<{ _createdAt: string; orderStatus: string }> {
	return dates.map((date) => ({ _createdAt: `${date}T12:00:00Z`, orderStatus: 'complete' }))
}
