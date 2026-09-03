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
	 * Distinct visitors per Vercel — the only visitor figure here that consent refusal and
	 * ad-blocking cannot reduce, because it is counted server-side.
	 */
	vercelVisitors: MetricValue
	/**
	 * True when Vercel bucketed this range weekly or monthly, so the trend shows GA4 alone.
	 * The chart still renders; the panel says which line is missing and why.
	 */
	vercelDailyUnavailable: boolean
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
	/** GA4 `sessionMedium`, e.g. `cpc` or `organic`. Null when GA4 reported none. */
	medium: string | null
	/** Campaign name, or null for organic and direct traffic where GA4 returns a placeholder. */
	campaign: string | null
	sessions: number
	/** Sessions GA4 counted as engaged, or null when unavailable. */
	engagedSessions: number | null
	/** Engaged over total — the quality signal that stops Display ranking equal to Search. */
	engagementRate: number | null
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
	/** Path including the query string, so a paid landing page is distinguishable from its twin. */
	path: string
	sessions: number
	/** Sessions GA4 counted as engaged, or null when unavailable. */
	engagedSessions: number | null
	/** Engaged over total, or null when there is nothing to divide. */
	engagementRate: number | null
}

/**
 * A successful outcome that is not a licence sale.
 *
 * Kept beside the funnel rather than inside it: an enquiry is an alternative ending, not a later
 * stage, and slotting it into the sequence would imply a visitor passes through it on the way to
 * a purchase.
 */
export interface JourneyOutcome {
	key: string
	label: string
	/** Why this outcome matters, shown beneath the figure. */
	note: string
	count: MetricValue
}

/** How far visitors get. Per-step totals, never an observed path. */
export interface JourneyData {
	steps: JourneyStep[]
	/**
	 * Where sessions began, busiest first. GA4 exposes entries but not exits — the previous
	 * `topExitPages` queried a metric GA4 has never had and was permanently empty.
	 */
	topLandingPages: LandingPage[]
	/** Conversions that are not a sale — enquiries, subscribes, trial downloads. */
	outcomes: JourneyOutcome[]
	/**
	 * How the step figures were obtained.
	 *
	 * `sequence` is a tracked, closed funnel from runFunnelReport: each step counts users who got
	 * there having completed the earlier ones. `independent-totals` is the fallback, where each
	 * step is its own count and a visitor at one is not necessarily the visitor at the next. The
	 * two must not be described the same way.
	 */
	measurement: 'sequence' | 'independent-totals'
	/** True only for the independent-totals fallback. A tracked funnel is not an approximation. */
	approximate: boolean
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
	/**
	 * Revenue attributed to this family, apportioned evenly across the families on each order.
	 * Unavailable when the site names no order total field.
	 */
	revenue: MetricValue
	/** Tested divided by viewed. Null unless both are real numbers. */
	testRate: number | null
	/**
	 * Orders over distinct viewers. The ratio a foundry acts on: it sorts the catalogue into
	 * families that are looked at and do not sell, which is where a pricing or specimen-page
	 * problem shows up. Null when either side is unavailable.
	 */
	buyRate: number | null
}

/** Viewed, tested and bought, by family. */
export interface TypefaceInterestData {
	rows: TypefaceInterestRow[]
	/** Stated in the response so the UI cannot omit it. */
	interpretationNote: string
	/** True when GA4 withheld low-count rows, so quiet families may be missing entirely. */
	rowsWithheld: boolean
	/** GA4's row cap was reached, so families past it are missing rather than idle. */
	rowsTruncated: boolean
	/** Whether the revenue column is an apportionment rather than a measured per-family value. */
	revenueIsApportioned: boolean
	/** ISO 4217 code for the revenue column, or null when revenue is unavailable. */
	currency: string | null
}
