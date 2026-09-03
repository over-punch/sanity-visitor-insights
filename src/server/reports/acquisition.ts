/**
 * Acquisition — where visitors come from.
 *
 * Design-industry referrers are pulled out as a named segment rather than left in a generic
 * referrer table. A visit from Fonts In Use or Typewolf is a pre-qualified, industry-literate
 * visitor and behaves nothing like average organic traffic; burying those rows among search and
 * social discards the distinction a foundry actually acts on.
 *
 * `(not set)` rows are surfaced rather than swept into "other". On a type-foundry site they can be
 * a large share — bookmarked visits, stripped referrers, AI crawlers — and hiding them makes the
 * table look more complete than it is.
 */

import type { AcquisitionData, SourceRow } from '../../reportData'
import type { DateRange } from '../../types'
import { sumFirstMetric, type Ga4Client } from '../ga4'
import type { SiteAnalyticsConfig } from '../../core/siteConfig'

/** Referrer hosts that identify a design-industry source worth tracking separately. */
export const DESIGN_INDUSTRY_SOURCES = [
	'fontsinuse.com',
	'typewolf.com',
	'typographica.org',
	'fonts.google.com',
	'behance.net',
	'dribbble.com',
	'itsnicethat.com',
] as const



/** Whether a GA4 source value is one of the unattributed buckets rather than a real referrer. */
function isUnattributed(source: string): boolean {
	const normalised = source.toLowerCase()
	return normalised === '(not set)' || normalised === '(direct)' || normalised === '(none)' || normalised === ''
}

/** Whether a GA4 source value matches a design-industry referrer. */
/**
 * Normalise GA4's campaign placeholder into an absent value.
 *
 * GA4 returns the literal string `(not set)` for organic and direct traffic, which is not a
 * campaign and must not be rendered as one.
 */
function campaignName(raw: string | undefined): string | null {
	if (!raw) return null
	const trimmed = raw.trim()
	return trimmed === '' || trimmed === '(not set)' || trimmed === '(direct)' ? null : trimmed
}

function isDesignIndustry(source: string, extra: readonly string[] = []): boolean {
	const normalised = source.toLowerCase()
	// The shipped list is generic and goes stale — a foundry's own press is a particular newsletter
	// or a regional publication that cannot be in a package constant. Without the per-site addition,
	// this figure reported the coverage of a hard-coded list while reading as a verdict on the
	// design press.
	const known = [...DESIGN_INDUSTRY_SOURCES, ...extra.map((host) => host.toLowerCase())]
	return known.some((host) => normalised === host || normalised.endsWith(`.${host}`))
}

/** Inputs for the acquisition report. */
export interface AcquisitionInput {
	config: SiteAnalyticsConfig
	range: DateRange
	ga4: Ga4Client
	/** Maximum source rows to return. */
	limit?: number
	notices?: string[]
}

/**
 * Run the acquisition report.
 *
 * @param input - the site config, range and GA4 client
 */
export async function acquisition(input: AcquisitionInput): Promise<AcquisitionData> {
	const { config, range, ga4, notices } = input
	const limit = input.limit ?? 25

	const report = await ga4.runReport({
		// Campaign and medium alongside source. Without them every campaign, ad group and keyword
		// collapsed into one "google / Paid Search" row, so there was no unit of spend in this tool
		// that a buyer could pause.
		dimensions: [
			{ name: 'sessionSource' },
			{ name: 'sessionDefaultChannelGroup' },
			{ name: 'sessionMedium' },
			{ name: 'sessionCampaignName' },
		],
		metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
		dateRanges: [{ startDate: range.start, endDate: range.end }],
		orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
		limit,
		// The denominator has to span every row, not the ones that fit under `limit`. Summing the
		// returned rows gave the top-25 subtotal, and dividing a share by it inflated that share —
		// systematically, because a design-industry referrer large enough to matter is almost
		// always inside the top 25 while the long tail it should be measured against is not.
		metricAggregations: ['TOTAL'],
	})

	// Sampling was captured from the response and then never shown, so a sampled report rendered
	// with the same authority as an exact one.
	if (report.sampled) notices?.push('GA4 answered this acquisition report from a sample, so the session counts are estimates.')

	const rows: SourceRow[] = report.rows.map((row) => {
		const source = row.dimensions[0] ?? '(not set)'
		const sessions = row.metrics[0]
		const engaged = row.metrics[1]
		const sessionCount = Number.isFinite(sessions) ? (sessions as number) : 0
		const engagedCount = Number.isFinite(engaged) ? (engaged as number) : null

		return {
			source,
			channel: row.dimensions[1] ?? 'Unassigned',
			medium: row.dimensions[2] || null,
			campaign: campaignName(row.dimensions[3]),
			sessions: sessionCount,
			engagedSessions: engagedCount,
			engagementRate: engagedCount !== null && sessionCount > 0 ? engagedCount / sessionCount : null,
			designIndustry: isDesignIndustry(source, config.designIndustrySources),
			unattributed: isUnattributed(source),
		}
	})

	// GA4's own total across all rows. Falls back to the row sum only if the totals block is
	// missing, in which case the shares below are withheld rather than computed against a subtotal.
	const totalSessions = report.metricTotal ?? sumFirstMetric(report)
	const totalIsComplete = report.metricTotal !== undefined || report.rowCount <= report.rows.length
	const sumWhere = (predicate: (row: SourceRow) => boolean) =>
		rows.filter(predicate).reduce((total, row) => total + row.sessions, 0)

	return {
		rows,
		totalSessions,
		// Withheld, not approximated, when the denominator cannot be trusted. A share of an unknown
		// whole is not a smaller truth, it is a different number wearing a percent sign.
		designIndustryShare: totalIsComplete && totalSessions > 0 ? sumWhere((r) => r.designIndustry) / totalSessions : null,
		unattributedShare: totalIsComplete && totalSessions > 0 ? sumWhere((r) => r.unattributed) / totalSessions : null,
		rowsWithheld: report.thresholded,
		/** True when GA4 held more source rows than were returned under `limit`. */
		rowsTruncated: report.rowCount > report.rows.length,
	}
}

export type { AcquisitionData, SourceRow } from '../../reportData'
