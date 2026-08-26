/**
 * Preflight diagnostics — run these the moment real credentials exist.
 *
 * Every panel in this package is only as trustworthy as the property behind it, and the ways a GA4
 * property can quietly produce wrong numbers are not visible from the numbers themselves: retention
 * silently truncating a year range, a timezone that disagrees with the site config, an event the
 * config claims is live that has never actually fired, a `purchase` with no `transaction_id` to
 * join against.
 *
 * Each check is written to distinguish "measured and fine" from "measured and broken" from "could
 * not measure" — the same discipline the reports themselves use. Nothing here writes anything, so
 * it is safe to run against production at any time.
 */

import type { CheckStatus, DiagnosticCheck, DiagnosticReport } from '../reportData'
import type { SiteAnalyticsConfig } from '../core/siteConfig'
import { PREEXISTING } from '../core/cutover'
import { shiftDays, formatInTimeZone } from '../core/ranges'
import { eventNameFilter, sumFirstMetric, type Ga4Client } from './ga4'
import type { VercelClient } from './vercel'
import { countOrders, type SanityQueryClient } from './orders'

/** Inputs for a diagnostic run. */
export interface DiagnosticsInput {
	config: SiteAnalyticsConfig
	ga4: Ga4Client | null
	vercel: VercelClient | null
	sanity: SanityQueryClient | null
	/** Injectable clock, so the checks are deterministic under test. */
	now?: Date
}

/** Severity ordering, worst last. */
const SEVERITY: CheckStatus[] = ['pass', 'skipped', 'warn', 'fail']

/** Reduce a set of checks to the worst status present. */
function worst(checks: DiagnosticCheck[]): CheckStatus {
	return checks.reduce<CheckStatus>((acc, check) => (SEVERITY.indexOf(check.status) > SEVERITY.indexOf(acc) ? check.status : acc), 'pass')
}

/**
 * Run every preflight check.
 *
 * Each check is independent and its failure is caught, so one broken upstream cannot hide the
 * results of the others — the point of this report is to see everything wrong at once.
 */
export async function runDiagnostics(input: DiagnosticsInput): Promise<DiagnosticReport> {
	const { config, ga4, vercel, sanity } = input
	const now = input.now ?? new Date()
	const checks: DiagnosticCheck[] = []

	const timezone = config.ga4?.timezone ?? 'UTC'
	const today = formatInTimeZone(now, timezone)

	// --- GA4 reachability -----------------------------------------------------
	let ga4Reachable = false
	let reportedTimeZone: string | undefined

	if (!ga4) {
		checks.push({
			id: 'ga4-auth',
			label: 'GA4 reachable',
			status: 'skipped',
			detail: 'GA4 is not configured for this site.',
		})
	} else {
		try {
			const probe = await ga4.runReport({
				metrics: [{ name: 'sessions' }],
				dateRanges: [{ startDate: shiftDays(today, -7), endDate: today }],
			})
			ga4Reachable = true
			reportedTimeZone = probe.timeZone

			checks.push({
				id: 'ga4-auth',
				label: 'GA4 reachable',
				status: 'pass',
				detail: `Property ${config.ga4?.propertyId} answered. ${sumFirstMetric(probe)} sessions in the last 7 days.`,
			})
		} catch (e) {
			checks.push({
				id: 'ga4-auth',
				label: 'GA4 reachable',
				status: 'fail',
				detail: (e as Error).message,
				remedy:
					'Check the service account is valid and has Viewer on this property, and that the property id is the numeric one from GA4 Admin rather than the G- measurement id.',
			})
		}
	}

	// --- Timezone agreement ---------------------------------------------------
	if (!ga4Reachable) {
		checks.push({ id: 'ga4-timezone', label: 'Timezone matches config', status: 'skipped', detail: 'GA4 did not answer.' })
	} else if (!reportedTimeZone) {
		checks.push({
			id: 'ga4-timezone',
			label: 'Timezone matches config',
			status: 'warn',
			detail: 'GA4 did not report a timezone, so the configured value could not be confirmed.',
		})
	} else if (reportedTimeZone !== timezone) {
		checks.push({
			id: 'ga4-timezone',
			label: 'Timezone matches config',
			status: 'fail',
			detail: `Config says ${timezone}; the property is set to ${reportedTimeZone}.`,
			remedy:
				'Set ga4.timezone to the property timezone. A mismatch shifts day and week boundaries, so GA4, Vercel and Sanity stop agreeing about which period an event belongs to.',
		})
	} else {
		checks.push({
			id: 'ga4-timezone',
			label: 'Timezone matches config',
			status: 'pass',
			detail: `Both are ${timezone}.`,
		})
	}

	// --- Retention window -----------------------------------------------------
	// Measured rather than read: the Admin setting is not exposed to the Data API, but its effect
	// is — probe a window well beyond the 2-month default and see whether anything comes back.
	if (!ga4Reachable || !ga4) {
		checks.push({ id: 'ga4-retention', label: 'Retention covers a year', status: 'skipped', detail: 'GA4 did not answer.' })
	} else {
		try {
			const oldStart = shiftDays(today, -365)
			const oldEnd = shiftDays(today, -120)
			const old = await ga4.runReport({
				metrics: [{ name: 'sessions' }],
				dateRanges: [{ startDate: oldStart, endDate: oldEnd }],
			})

			const oldSessions = sumFirstMetric(old)

			if (oldSessions > 0) {
				checks.push({
					id: 'ga4-retention',
					label: 'Retention covers a year',
					status: 'pass',
					detail: `${oldSessions} sessions found between ${oldStart} and ${oldEnd}, so the year range has data.`,
				})
			} else {
				checks.push({
					id: 'ga4-retention',
					label: 'Retention covers a year',
					status: 'warn',
					detail: `No sessions between ${oldStart} and ${oldEnd}. Either the site had no traffic then, or event-data retention is set shorter than that window.`,
					remedy:
						'Check GA4 Admin, Data Settings, Data Retention and set it to 14 months. It does not backfill, so the sooner it is changed the sooner the year range becomes usable.',
				})
			}
		} catch (e) {
			checks.push({
				id: 'ga4-retention',
				label: 'Retention covers a year',
				status: 'warn',
				detail: `Could not probe the retention window: ${(e as Error).message}`,
			})
		}
	}

	// --- Configured events actually fire --------------------------------------
	if (!ga4Reachable || !ga4) {
		checks.push({ id: 'ga4-events', label: 'Configured events fire', status: 'skipped', detail: 'GA4 did not answer.' })
	} else {
		try {
			const seen = await ga4.runReport({
				dimensions: [{ name: 'eventName' }],
				metrics: [{ name: 'eventCount' }],
				dateRanges: [{ startDate: shiftDays(today, -30), endDate: today }],
				limit: 200,
			})

			const firing = new Set(seen.rows.map((row) => row.dimensions[0]).filter(Boolean) as string[])

			// Events the config claims are long-established but which GA4 has never seen.
			const claimedButAbsent = Object.entries(config.eventCutovers)
				.filter(([name, cutover]) => cutover === PREEXISTING && !firing.has(name))
				.map(([name]) => name)

			// Events GA4 is recording that the config does not know about, so they are unreportable.
			const firingButUnconfigured = [...firing].filter((name) => !(name in config.eventCutovers))

			if (claimedButAbsent.length > 0) {
				checks.push({
					id: 'ga4-events',
					label: 'Configured events fire',
					status: 'fail',
					detail: `Config marks these as already live, but GA4 saw none in the last 30 days: ${claimedButAbsent.join(', ')}.`,
					remedy:
						'Either the event is not actually firing, or the cutover map is wrong. Panels depending on it will show figures that look real but are not.',
				})
			} else {
				checks.push({
					id: 'ga4-events',
					label: 'Configured events fire',
					status: 'pass',
					detail: `All events marked live are firing. ${firing.size} distinct events seen in the last 30 days.`,
				})
			}

			if (firingButUnconfigured.length > 0) {
				checks.push({
					id: 'ga4-unconfigured-events',
					label: 'No unreportable events',
					status: 'warn',
					detail: `GA4 is recording events absent from the cutover map, so they cannot be reported: ${firingButUnconfigured.slice(0, 10).join(', ')}${firingButUnconfigured.length > 10 ? '…' : ''}.`,
					remedy: 'Add them to eventCutovers if they are worth reporting.',
				})
			}
		} catch (e) {
			checks.push({
				id: 'ga4-events',
				label: 'Configured events fire',
				status: 'warn',
				detail: `Could not list events: ${(e as Error).message}`,
			})
		}
	}

	// --- purchase carries a join key ------------------------------------------
	if (!ga4Reachable || !ga4) {
		checks.push({ id: 'ga4-transaction-id', label: 'Purchases carry transaction_id', status: 'skipped', detail: 'GA4 did not answer.' })
	} else {
		try {
			const purchases = await ga4.runReport({
				dimensions: [{ name: 'transactionId' }],
				metrics: [{ name: 'eventCount' }],
				dateRanges: [{ startDate: shiftDays(today, -90), endDate: today }],
				dimensionFilter: eventNameFilter('purchase'),
				limit: 50,
			})

			const ids = purchases.rows.map((row) => row.dimensions[0] ?? '')
			const usable = ids.filter((id) => id && id !== '(not set)')

			if (ids.length === 0) {
				checks.push({
					id: 'ga4-transaction-id',
					label: 'Purchases carry transaction_id',
					status: 'skipped',
					detail: 'No purchase events in the last 90 days to inspect.',
				})
			} else if (usable.length === 0) {
				checks.push({
					id: 'ga4-transaction-id',
					label: 'Purchases carry transaction_id',
					status: 'fail',
					detail: `${ids.length} purchase rows, none with a usable transaction_id.`,
					remedy:
						'Send transaction_id (the Sanity orderNumber) on every purchase event. Without it a GA4 purchase cannot be reconciled against an order, so the conversion anchor cannot be verified.',
				})
			} else {
				checks.push({
					id: 'ga4-transaction-id',
					label: 'Purchases carry transaction_id',
					status: usable.length === ids.length ? 'pass' : 'warn',
					detail: `${usable.length} of ${ids.length} purchase rows carry a transaction_id.`,
				})
			}
		} catch (e) {
			checks.push({
				id: 'ga4-transaction-id',
				label: 'Purchases carry transaction_id',
				status: 'warn',
				detail: `Could not inspect purchases: ${(e as Error).message}`,
			})
		}
	}

	// --- GA4 purchases against Sanity orders ----------------------------------
	if (!ga4Reachable || !ga4 || !sanity) {
		checks.push({
			id: 'purchase-order-agreement',
			label: 'GA4 purchases match orders',
			status: 'skipped',
			detail: 'Needs both GA4 and Sanity.',
		})
	} else {
		try {
			const start = shiftDays(today, -30)
			const [ga4Purchases, orders] = await Promise.all([
				ga4.runReport({
					metrics: [{ name: 'eventCount' }],
					dateRanges: [{ startDate: start, endDate: today }],
					dimensionFilter: eventNameFilter('purchase'),
				}),
				countOrders(sanity, config.orders.documentType, start, today, config.orders.excludeFilter),
			])

			const tracked = sumFirstMetric(ga4Purchases)
			const actual = orders.total

			if (actual === 0 && tracked === 0) {
				checks.push({
					id: 'purchase-order-agreement',
					label: 'GA4 purchases match orders',
					status: 'skipped',
					detail: 'No orders and no purchase events in the last 30 days.',
				})
			} else {
				const divergence = actual > 0 ? Math.abs(tracked - actual) / actual : 1
				checks.push({
					id: 'purchase-order-agreement',
					label: 'GA4 purchases match orders',
					status: divergence <= 0.15 ? 'pass' : 'warn',
					detail: `GA4 recorded ${tracked} purchases; Sanity has ${actual} orders in the same 30 days.`,
					remedy:
						divergence > 0.15
							? 'A large gap usually means purchase is firing on a page some buyers never reach, firing twice, or being blocked. Worth resolving before trusting any conversion figure.'
							: undefined,
				})
			}
		} catch (e) {
			checks.push({
				id: 'purchase-order-agreement',
				label: 'GA4 purchases match orders',
				status: 'warn',
				detail: `Could not compare: ${(e as Error).message}`,
			})
		}
	}

	// --- Vercel ---------------------------------------------------------------
	if (!vercel) {
		checks.push({
			id: 'vercel',
			label: 'Vercel Web Analytics reachable',
			status: 'skipped',
			detail: 'Vercel is not configured for this site. Measurement health will have only one pageview source.',
		})
	} else {
		try {
			const result = await vercel.pageviews(shiftDays(today, -7), today)
			checks.push({
				id: 'vercel',
				label: 'Vercel Web Analytics reachable',
				status: 'pass',
				detail: `${result.total} pageviews in the last 7 days.`,
			})
		} catch (e) {
			checks.push({
				id: 'vercel',
				label: 'Vercel Web Analytics reachable',
				status: 'warn',
				detail: (e as Error).message,
				remedy:
					'Web Analytics API access depends on plan tier. Without it, measurement health cannot compare two pageview sources and the panel loses its point.',
			})
		}
	}

	return { checks, verdict: worst(checks) }
}

export type { CheckStatus, DiagnosticCheck, DiagnosticReport } from '../reportData'
