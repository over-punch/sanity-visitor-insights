/**
 * Data hook for the Studio panels.
 *
 * Forwards the Studio's own Sanity session token to the site's API route, which verifies it against
 * Sanity. There is no shared secret: the Studio bundle is public, so anything compiled into it is
 * extractable.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useClient } from 'sanity'
import type { RangeKey, ReportEnvelope, ReportName } from '../types'

/**
 * Envelopes already fetched this session, keyed by what identifies them.
 *
 * Module-level and deliberately unbounded within a session: there are five reports and a handful of
 * ranges, so the ceiling is tens of entries. Without it every tab visit was a fresh round trip —
 * Acquisition to Journey and back paid twice and waited twice — and the server's own cache is
 * per-instance with a five-minute TTL, so a cold serverless instance re-fanned-out to GA4, Vercel,
 * Sanity and Mailchimp to answer a question it had answered a moment earlier.
 *
 * Served immediately, then revalidated behind, so a return trip is a view change rather than a
 * page load. That is most of what makes five tabs feel like one dataset.
 */
const envelopeCache = new Map<string, ReportEnvelope<unknown>>()

/**
 * The last GA4 shortfall seen for a given site and window, so every tab can know it.
 *
 * `shortfallRatio` is computed by one report. The other three panels are built entirely from GA4
 * and had no access to it at any position on the page, so the tool could print "GA4 is seeing 20%
 * of your traffic — treat its figures as broken" on one tab and then render `Sessions 357` in the
 * largest available type on the next, with nothing anywhere saying it was a fifth of reality. A
 * source that answers confidently and wrongly is `status: 'ok'`, so the source row cannot catch it.
 *
 * Keyed by site and window because the shortfall is a property of both — carrying last week's
 * figure onto a quarter view would be a different lie.
 */
const shortfallByWindow = new Map<string, number>()

/** The window part of a cache key: the named range, or the custom bounds. */
function windowKey(range: string, custom?: { start: string; end: string }): string {
	return range === 'custom' && custom ? `${custom.start}..${custom.end}` : range
}

/**
 * What is known about GA4's coverage of this site and window, or null when nothing is.
 *
 * Null is a real answer and must render as nothing: a panel that cannot say how lossy its source is
 * should not imply the source is fine.
 *
 * @param base - the site's API base URL, as passed to the tool
 * @param range - the range name currently selected
 * @param custom - the custom bounds, when the range is custom
 */
export function knownShortfall(base: string, range: string, custom?: { start: string; end: string }): number | null {
	return shortfallByWindow.get(`${base}|${windowKey(range, custom)}`) ?? null
}

/**
 * Record a shortfall an envelope carried, if it carried one.
 *
 * Exported for its tests, not for consumers — deliberately absent from `src/index.ts`, so it is a
 * module seam rather than public API.
 */
export function rememberShortfall(base: string, range: string, custom: { start: string; end: string } | undefined, data: unknown): void {
	const ratio = (data as { shortfallRatio?: unknown } | null)?.shortfallRatio
	// Bounded on both sides: a ratio outside 0..1 is a bug upstream, not a coverage figure.
	if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
		shortfallByWindow.set(`${base}|${windowKey(range, custom)}`, ratio)
	}
}

/** Identity of a request: everything that changes the answer. */
function cacheKey(base: string, report: string, range: string, custom?: { start: string; end: string }, compare?: string): string {
	// apiBaseUrl included: the plugin takes a `name` so it can be registered twice in one Studio,
	// and without the base those two registrations would serve each other's envelopes.
	// The comparison basis is part of the key: two bases produce different envelopes for the same
	// window, and without it switching baseline would serve the other one's deltas from cache.
	return [base, report, range, custom?.start ?? '', custom?.end ?? '', compare ?? 'previous-period'].join('|')
}

/**
 * Whether a previous answer may stay on screen while the next one loads.
 *
 * Only for the same report. Held across a RANGE change, which is the point — a reader must be able
 * to change one variable without losing their sort, their filter and their place. NOT held across
 * a REPORT change: that handed one panel another's payload, which does not crash, because every
 * field is guarded with `?? []`, and therefore silently drew an empty funnel. Wrong content is
 * worse than a spinner, and unlike a spinner it looks like an answer.
 *
 * Exported as a pure predicate so it can be tested without a DOM, which this package does not have.
 *
 * @param current - the state on screen right now
 * @param nextReport - the report about to be fetched
 */
export function holdsPreviousAnswer<T>(current: ReportState<T>, nextReport: ReportName): boolean {
	return current.status === 'ready' && current.envelope.report === nextReport
}

/** Sanity API version this tool pins. Fixed rather than "latest" so behaviour cannot drift. */
const API_VERSION = '2024-03-01'

/** Loading state for a report. */
export type ReportState<T> =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'ready'; envelope: ReportEnvelope<T>; stale?: boolean; revalidationError?: string }
	// `disabled` separates "this site has visitor insights switched off" from "something broke".
	// They are both non-200s, but only one of them is worth a retry button.
	| { status: 'error'; message: string; disabled?: boolean }

/** Options for useReport. */
export interface UseReportOptions {
	/** Explicit dates, required when `range` is 'custom' and ignored otherwise. */
	custom?: { start: string; end: string }
	/** Base URL of the site serving the reports, e.g. `https://dardenstudio.com`. */
	apiBaseUrl: string
	report: ReportName
	range: RangeKey
	/** Which baseline the deltas are measured against. Defaults to the preceding window. */
	compare?: 'previous-period' | 'same-period-last-year'
	/**
	 * Whether to fetch at all. Defaults to true.
	 *
	 * Lets a panel declare a secondary report it only needs on one tab, without the other four
	 * paying a request for data they will not draw.
	 */
	enabled?: boolean
}

/**
 * Fetch a report, re-fetching when the range changes.
 *
 * @returns the current state plus a `reload` for manual refresh
 */
export function useReport<T>({ apiBaseUrl, report, range, custom, compare, enabled = true }: UseReportOptions): {
	state: ReportState<T>
	reload: () => void
} {
	const client = useClient({ apiVersion: API_VERSION })
	const [state, setState] = useState<ReportState<T>>({ status: 'idle' })
	const [nonce, setNonce] = useState(0)

	// Lets an in-flight response from a previous range be discarded rather than overwriting a newer one.
	const requestIdRef = useRef(0)

	const reload = useCallback(() => setNonce((n) => n + 1), [])

	useEffect(() => {
		if (!enabled) return
		const requestId = requestIdRef.current + 1
		requestIdRef.current = requestId

		const controller = new AbortController()
		const key = cacheKey(apiBaseUrl, report, range, custom, compare)
		const cached = envelopeCache.get(key)

		// A cached answer for THIS key is shown at once and still revalidated. Marked stale so the
		// reader knows a fresher one is coming, rather than being told nothing and wondering.
		if (cached) setState({ status: 'ready', envelope: cached as ReportEnvelope<T>, stale: true })

		// Keep showing the last answer while fetching the next one, marked stale.
		//
		// This used to clear to `loading` unconditionally, which unmounted the ready subtree and
		// took every table's sort, filter and exclusions with it. Widen Week to Month to check
		// whether a ranking holds and the ranking is gone, after the screen went blank — so a reader
		// could never hold a question steady while changing one variable, which is the whole of
		// what "explorable" means. It also dumped keyboard focus to the body on every range change.
		// Only a previous answer FOR THE SAME REPORT may be held over. Without that check, switching
		// tabs with nothing cached kept the old envelope and handed it to the new panel — Journey
		// rendered with Acquisition's payload, which does not crash (every field is guarded with
		// `?? []`) and therefore silently drew an empty funnel instead. Wrong content is worse than
		// a spinner, and unlike a spinner it looks like an answer.
		else {
			setState((current) => (
				holdsPreviousAnswer(current, report) ? { ...current, stale: true } : { status: 'loading' }
			))
		}

		async function run() {
			// The Studio client carries the session token under token-based auth. Under cookie-based
			// auth it does not, and there is no way to forward credentials the browser will not
			// expose — so say so plainly rather than failing with an opaque 401.
			const token = client.config().token
			if (!token) {
				setState({
					status: 'error',
					message: 'No Sanity session token available in this Studio. Visitor Insights needs token-based auth to call the site API.',
				})
				return
			}

			try {
				// Coerced rather than assumed. An empty base is legitimate — it means the Studio is
				// served from the same origin as the site — but an undefined one used to reach
				// .replace() directly and crash every panel with a stack trace instead of a
				// message. Treating a missing base as same-origin degrades to the common case.
				const base = typeof apiBaseUrl === 'string' ? apiBaseUrl.replace(/\/$/, '') : ''
				// Custom ranges carry their own dates. Built with URLSearchParams so a date can
				// never break the query string, and so the two named-range and custom-range paths
				// produce one shape rather than two.
				const query = new URLSearchParams({ range })
				// Only sent when it differs from the default, so an unchanged request keeps the exact
				// URL — and therefore the exact cache key — it had before this option existed.
				if (compare && compare !== 'previous-period') query.set('compare', compare)
				if (range === 'custom' && custom) {
					query.set('start', custom.start)
					query.set('end', custom.end)
				}
				const url = `${base}/api/visitor-insights/${report}?${query.toString()}`
				const response = await fetch(url, {
					headers: { Authorization: `Bearer ${token}` },
					signal: controller.signal,
				})

				if (requestIdRef.current !== requestId) return

				if (!response.ok) {
					// A 400 is the handler rejecting the request itself — an inverted or oversized
					// custom range, most often — and a 503 is the site's master switch being off.
					// Both carry a message written for the reader. Anything else may echo upstream
					// detail, so only the status crosses over.
					let detail = response.status === 401
						? 'Not authorised — sign in to the Studio again.'
						: `Request failed (${response.status})`
					let disabled = false
					if (response.status === 400 || response.status === 503) {
						const body = (await response.json().catch(() => null)) as { error?: string; disabled?: boolean } | null
						if (body?.error) detail = body.error
						disabled = body?.disabled === true
					}
					if (requestIdRef.current !== requestId) return
					setState({ status: 'error', message: detail, disabled })
					return
				}

				const envelope = (await response.json()) as ReportEnvelope<T>
				if (requestIdRef.current !== requestId) return

				envelopeCache.set(key, envelope as ReportEnvelope<unknown>)
				rememberShortfall(apiBaseUrl, range, custom, envelope.data)
				setState({ status: 'ready', envelope })
			} catch (e) {
				if (controller.signal.aborted || requestIdRef.current !== requestId) return
				// A failed REVALIDATION must not destroy the figures already on screen. It used to
				// replace a readable panel with a red card, and "Try again" flashed the data back
				// and then the error again. The last good answer stays; the failure is reported
				// beside it.
				setState((current) => (
					current.status === 'ready'
						? { ...current, stale: false, revalidationError: (e as Error).message }
						: { status: 'error', message: (e as Error).message }
				))
			}
		}

		void run()
		return () => controller.abort()
	// custom.start/end by value rather than the object: the caller builds a fresh object on every
	// render, and depending on its identity would refetch on each keystroke in the date fields.
	}, [client, apiBaseUrl, report, range, custom?.start, custom?.end, nonce, enabled])

	return { state, reload }
}

/** Drop every remembered shortfall. For tests, so one case cannot leak into the next. */
export function forgetShortfalls(): void {
	shortfallByWindow.clear()
}
