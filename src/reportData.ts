/**
 * Report result shapes, shared by the server that produces them and the panels that render them.
 *
 * These live outside both entry points on purpose. If the panels imported them from
 * `src/server/reports/*` — even as `import type`, which does erase at build time — the module
 * graph would still contain a client-to-server edge, and the guarantee that credential-reading
 * code cannot reach a Studio bundle would rest on a compiler detail rather than on structure.
 */

import type { MetricValue } from './types'

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Outcome of one preflight check. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped'

/** One diagnostic result. */
export interface DiagnosticCheck {
	id: string
	label: string
	status: CheckStatus
	/** What was actually observed. */
	detail: string
	/** What to do about it, when there is something to do. */
	remedy?: string
}

/** A full preflight run. */
export interface DiagnosticReport {
	checks: DiagnosticCheck[]
	/** Worst status across all checks, for a single at-a-glance verdict. */
	verdict: CheckStatus
}

// ---------------------------------------------------------------------------
// Measurement health
// ---------------------------------------------------------------------------

/** How much of reality each source sees. Pageviews compare like with like; the rest is context. */
export interface MeasurementHealthData {
	/** GA4 pageviews — directly comparable to `vercelPageviews`. */
	ga4Pageviews: MetricValue
	/** Vercel pageviews — cookieless, not consent-gated. */
	vercelPageviews: MetricValue
	/**
	 * Vercel minus GA4 pageviews, as a share of Vercel. Positive means GA4 saw less.
	 * Null when either side is unavailable — never computed against a missing operand.
	 */
	shortfallRatio: number | null
	/** GA4 sessions. Context only: a session is not a pageview and is never subtracted from one. */
	ga4Sessions: MetricValue
	/** Orders in range. Ground truth for conversions, shown as context. */
	orders: MetricValue
	/** Share of sessions that granted consent, where the event exists. */
	consentRate: MetricValue
	/** Plain-language reading of the numbers above, for a non-analyst audience. */
	interpretation: string
	/**
	 * Daily pageviews from both sources, oldest first.
	 *
	 * The single most useful thing this report holds, and it used to be fetched and discarded.
	 * A scalar shortfall cannot distinguish a gap that has been stable for a year from one that
	 * opened on a Tuesday — and those need opposite responses. Darden's GA4 fell 86% below Vercel
	 * overnight on 2026-08-24 and stayed there for over a week; the panel reported the magnitude
	 * faithfully and gave no way to see that it was a cliff.
	 *
	 * Empty when either source could not answer by day.
	 */
	daily: DailyPoint[]
}

/** One day's pageviews from each source. `null` where that source has no figure for the day. */
export interface DailyPoint {
	/** ISO date, YYYY-MM-DD. */
	date: string
	ga4: number | null
	vercel: number | null
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

/** One acquisition source. */
export interface SourceRow {
	/** GA4 `sessionSource` value. */
	source: string
	/** GA4 `sessionDefaultChannelGroup`, e.g. Organic Search. */
	channel: string
	sessions: number
	/** True when this source is one of the design-industry referrers. */
	designIndustry: boolean
	/** True for GA4's `(not set)` / `(direct)` style buckets, which are not real sources. */
	unattributed: boolean
}

/** Where visitors came from. */
export interface AcquisitionData {
	rows: SourceRow[]
	totalSessions: number
	/** Sessions from design-industry referrers, as a share of the total. */
	designIndustryShare: number | null
	/** Sessions GA4 could not attribute, as a share of the total. */
	unattributedShare: number | null
	/** True when GA4 withheld low-count rows, so the tail is shorter than reality. */
	rowsWithheld: boolean
	/**
	 * True when GA4 held more source rows than the query returned.
	 * The shares above are null in that case rather than divided by a partial total.
	 */
	rowsTruncated: boolean
}

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

/** One rung of the funnel. */
export interface JourneyStep {
	key: string
	label: string
	event: string
	count: MetricValue
	/**
	 * Share of the previous measurable step that reached this one.
	 * Null when either end is unavailable — a drop-off across an unmeasured step is meaningless.
	 */
	conversionFromPrevious: number | null
}

/** One landing page and the sessions that began on it. */
export interface LandingPage {
	path: string
	sessions: number
}

/** How far visitors get. Per-step totals, never an observed path. */
export interface JourneyData {
	steps: JourneyStep[]
	/**
	 * Where sessions began, busiest first. GA4 exposes entries but not exits — the previous
	 * `topExitPages` queried a metric GA4 has never had and was permanently empty.
	 */
	topLandingPages: LandingPage[]
	/** Always true. The UI must not present these steps as a tracked journey. */
	approximate: true
	/** Why it is approximate, in words the panel can show directly. */
	approximationNote: string
}

// ---------------------------------------------------------------------------
// Typeface interest
// ---------------------------------------------------------------------------

/** One family's interest figures. */
export interface TypefaceInterestRow {
	typeface: string
	viewed: MetricValue
	tested: MetricValue
	bought: MetricValue
	/** Tested divided by viewed. Null unless both are real numbers. */
	testRate: number | null
}

/** Viewed, tested and bought, by family. */
export interface TypefaceInterestData {
	rows: TypefaceInterestRow[]
	/** Stated in the response so the UI cannot omit it. */
	interpretationNote: string
	/** True when GA4 withheld low-count rows, so quiet families may be missing entirely. */
	rowsWithheld: boolean
}
