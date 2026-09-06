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
	/**
	 * The exact revenue and order count for this window, from Sanity, or null when unavailable.
	 *
	 * GA4 supplies the SHAPE of the attribution and Sanity supplies the SCALE. GA4's own purchase
	 * counts are as lossy as everything else it reports, so its absolute revenue figures would be an
	 * undercount of unknown size — but a uniform loss cancels in a ratio, so the SPLIT between
	 * channels survives it in a way the totals do not. Apportioning Sanity's exact total across
	 * GA4's split gives a figure that is right in scale and honest about its derivation, which is
	 * the whole reason to hold both sources.
	 */
	actuals?: { revenue: number | null; orders: number | null } | null
	notices?: string[]
}

/**
 * Run the acquisition report.
 *
 * @param input - the site config, range and GA4 client
 */
/**
 * The key both GA4 queries agree on: the four attribution dimensions, in order.
 *
 * GA4 returns the same placeholder strings for the same rows in both requests, so joining on the
 * raw values is exact — but only if they are read in the same order and normalised the same way,
 * which is why this exists rather than being inlined twice.
 *
 * @param dimensions - source, channel, medium, campaign, as GA4 returned them
 */
function attributionKey(dimensions: Array<string | undefined>): string {
	return dimensions.slice(0, 4).map((d) => d ?? '').join('\u0000')
}

export async function acquisition(input: AcquisitionInput): Promise<AcquisitionData> {
	const { config, range, ga4, notices, actuals } = input
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

	// The raw GA4 dimensions per row, kept for the join below.
	//
	// The row objects normalise as they build — `campaignName` turns GA4's placeholders into null,
	// `medium` turns an empty string into null — so rebuilding a join key out of the finished row
	// would not match what the second query returns for the same row. Joining on what GA4 actually
	// said is the only thing that matches.
	const rawKeys: string[] = []

	const rows: SourceRow[] = report.rows.map((row) => {
		rawKeys.push(attributionKey(row.dimensions))
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
			// All three filled in below, once the separate purchase query has answered.
			purchases: null,
			revenueShare: null,
			apportionedRevenue: null,
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

	/*
	 * Purchases in a SEPARATE request, and a failure here costs only the revenue column.
	 *
	 * Asking for it alongside sessions would have put the whole acquisition tab behind one metric
	 * name: GA4 rejects an unknown metric, and an incompatible dimension/metric pairing, with a 400
	 * for the ENTIRE request. This package has already shipped a metric that does not exist in GA4
	 * — `exits`, which went unnoticed for the life of the package — so a new metric name is not
	 * something to stake a working report on. Split, the attribution can only ever be additive.
	 *
	 * The dimensions match the session query exactly, so the two join row-for-row on the same key.
	 */
	const purchasesBySource = new Map<string, number>()
	/** GA4's own revenue per attribution row. Used only for its SHAPE — the unit cancels in a share. */
	const revenueBySource = new Map<string, number>()
	let purchasesAvailable = false
	try {
		const purchaseReport = await ga4.runReport({
			dimensions: [
				{ name: 'sessionSource' },
				{ name: 'sessionDefaultChannelGroup' },
				{ name: 'sessionMedium' },
				{ name: 'sessionCampaignName' },
			],
			/*
			 * REVENUE, not the purchase count, is what the split has to be built from.
			 *
			 * Applying a count share to a money total assumes every channel's average order is the
			 * same size, and this codebase argues at length that it is not — orders.ts justifies
			 * reading totals precisely because "a $30 web licence and a $400 multi-seat desktop
			 * licence are the same integer". One design-press referral bringing a single foundry-wide
			 * licence, against ten organic sessions bringing web licences, would have been printed at
			 * a tenth of the revenue it actually earned.
			 *
			 * GA4's revenue was declined here on the grounds that its currency handling depends on
			 * property configuration. That objection was about FORMATTING and does not apply: a share
			 * is a ratio, so the unit cancels. Only the shape is taken from GA4; the money still
			 * comes from Sanity.
			 *
			 * The count is kept alongside it, for the floor and for saying how thin the sample is.
			 */
			metrics: [{ name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
			dateRanges: [{ startDate: range.start, endDate: range.end }],
			limit: 250,
			metricAggregations: ['TOTAL'],
		})
		purchasesAvailable = true

		// The purchase query's own quality flags, which were read off the session query and never off
		// this one. A split computed from a sampled or privacy-thresholded report is not the same
		// claim as one computed from a complete one, and combining the two silently would let a
		// caveat that applies to half the arithmetic go unstated.
		if (purchaseReport.sampled) {
			notices?.push('GA4 answered the purchase-attribution query from a sample, so the revenue split is approximate even before its own coverage is considered.')
		}
		if (purchaseReport.thresholded || purchaseReport.rowCount > purchaseReport.rows.length) {
			notices?.push('GA4 withheld or truncated some attributed purchases, so the revenue split does not account for every sale it tracked.')
		}

		for (const row of purchaseReport.rows) {
			const count = row.metrics[0]
			const money = row.metrics[1]
			if (!Number.isFinite(count)) continue
			const key = attributionKey(row.dimensions)
			purchasesBySource.set(key, count as number)
			if (Number.isFinite(money)) revenueBySource.set(key, money as number)
		}
	} catch (error) {
		// Named, not swallowed. A silently absent column is indistinguishable from a channel that
		// sold nothing, which is the confusion this whole package exists to prevent.
		notices?.push(`GA4 would not report purchases by source, so revenue could not be split by channel: ${error instanceof Error ? error.message : 'unknown error'}`)
	}

	if (purchasesAvailable) {
		rows.forEach((row, index) => {
			const key = rawKeys[index] ?? ''
			row.purchases = purchasesBySource.get(key) ?? 0
			row.trackedRevenue = revenueBySource.get(key) ?? 0
		})
	}

	// The attribution split, and Sanity's exact total spread across it.
	//
	// Withheld entirely rather than approximated when GA4 saw too few purchases to divide by: at
	// these volumes a single tracked purchase would hand one channel 100% of the quarter's revenue,
	// which is a fabrication wearing a percentage sign. The floor matches the capture model's.
	// Summed over EVERY attributed row GA4 returned, not the rows shown.
	//
	// `rows` is the top 25 by SESSIONS, and purchases do not rank the same way — a design-press
	// referrer that sends little traffic and sells well sits outside it. Dividing by the visible
	// subtotal would inflate every share on screen, systematically and in the direction that
	// flatters whatever is already at the top. This is the same mistake the sessions denominator
	// above documents having made once.
	let trackedPurchases = 0
	for (const count of purchasesBySource.values()) trackedPurchases += count
	let trackedRevenue = 0
	for (const money of revenueBySource.values()) trackedRevenue += money
	// Eight, not five. At five, one attributed purchase carries twenty percentage points, so a
	// single sale could hand one channel the whole quarter — which is the fabrication the floor
	// exists to prevent, not something it prevented. The earlier comment claimed this matched the
	// capture model's floor; it did not. That floor is on an EXACT denominator, this one is on a
	// lossy numerator, and the same number means something much weaker here.
	/*
	 * Five, with a coverage WINDOW — not eight with a floor.
	 *
	 * Eight was unsatisfiable in the honest case and satisfiable only in the broken one. At seven
	 * orders a quarter, requiring eight attributed purchases requires coverage above 100%: GA4 must
	 * have attributed MORE purchases than orders exist, which happens when the purchase tag fires
	 * twice. So the column was withheld in every sound configuration and rendered in precisely the
	 * corrupt one. A gate that can only open on bad data is worse than no gate.
	 *
	 * The window has both ends now. Below a quarter of the order book the sample is too thin to
	 * divide revenue by; above about a fifth more purchases than orders, GA4 is counting sales that
	 * did not happen and its split cannot be trusted either.
	 */
	const MIN_TRACKED_PURCHASES = 5
	const MIN_COVERAGE = 0.25
	const MAX_COVERAGE = 1.2
	const coverage = actuals?.orders != null && actuals.orders > 0 ? trackedPurchases / actuals.orders : null

	const splitIsSound = trackedPurchases >= MIN_TRACKED_PURCHASES
		&& trackedRevenue > 0
		&& (coverage === null || (coverage >= MIN_COVERAGE && coverage <= MAX_COVERAGE))

	if (splitIsSound) {
		for (const row of rows) {
			const money = row.trackedRevenue
			if (money === null || money === undefined) continue
			// The share of GA4's own REVENUE, not of its purchase count — so a channel that brings
			// one large licence is not averaged down to the size of a channel bringing one small one.
			row.revenueShare = money / trackedRevenue
			// Sanity's exact total, split by GA4's shape. Null when Sanity could not supply one, so
			// the share still shows and only the money is withheld.
			row.apportionedRevenue = actuals?.revenue != null ? actuals.revenue * row.revenueShare : null
		}
	} else if (purchasesAvailable) {
		// Always says why, including at zero. The zero case fell through the old `> 0` branch in
		// silence, so a foundry whose ecommerce tagging is entirely broken — the loudest possible
		// finding, and the kind this package exists to surface — saw an unexplained column of dashes.
		const why = trackedPurchases > 0 && trackedRevenue <= 0
			// A diagnosable fault in its own right: the purchase event is firing and being attributed,
			// but carrying no value, so GA4 knows a sale happened and not what it was worth.
			? `GA4 attributed ${trackedPurchases} purchase${trackedPurchases === 1 ? '' : 's'} to a source but recorded no revenue against them, so there is no shape to split your takings by. The purchase event is firing without its value.`
			: coverage !== null && coverage > MAX_COVERAGE
				// Over-attribution is a finding, not a shortage. Reporting it as "too few" would send
				// the reader to widen the range, which makes a double-firing tag worse, not better.
				? `GA4 attributed ${trackedPurchases} purchases to a source but you only have ${actuals?.orders} orders in this range. It is counting sales that did not happen — usually a purchase tag firing twice — so its split cannot be trusted.`
				: trackedPurchases === 0
			? 'GA4 attributed no purchases at all to a source in this range, so revenue cannot be split by channel. That usually means the purchase event is not firing, or is firing without its source.'
			: coverage !== null && coverage < MIN_COVERAGE
				? `GA4 attributed ${trackedPurchases} of your ${actuals?.orders} orders to a source in this range — too small a sample of your own sales to divide revenue by.`
				: `GA4 attributed only ${trackedPurchases} purchase${trackedPurchases === 1 ? '' : 's'} to a source in this range, which is too few to split revenue by channel. Choose a longer range.`
		notices?.push(why)
	}

	// How much of the split is actually on screen. The shares are against every attributed
	// purchase, so when sources outside the visible rows made sales the visible shares correctly do
	// NOT sum to 100 — and a reader adding up a column that stops short deserves to be told why
	// rather than left to assume the arithmetic is broken.
	const shownPurchases = rows.reduce((total, row) => total + (row.purchases ?? 0), 0)

	return {
		rows,
		totalSessions,
		trackedPurchases,
		shownPurchases,
		splitIsSound,
		/** Sanity's exact figures for the same window, so the panel can say what it apportioned. */
		actualRevenue: actuals?.revenue ?? null,
		actualOrders: actuals?.orders ?? null,
		currency: config.orders?.currency ?? null,
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
