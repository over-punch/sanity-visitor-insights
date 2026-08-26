/**
 * Diagnostics tests.
 *
 * These prove the preflight checks will actually fire when the corresponding fault is present —
 * which matters more than usual here, because these checks exist precisely to run once, against a
 * live property, at a moment when nobody yet knows what that property looks like. A check that
 * silently passes on a broken property is worse than no check.
 */

import { describe, expect, it } from 'vitest'
import type { SiteAnalyticsConfig } from '../core/siteConfig'
import { PREEXISTING } from '../core/cutover'
import {
	createFakeGa4Client,
	createFakeSanityClient,
	createFakeVercelClient,
	makeGa4Report,
	makeGa4Total,
	makeOrders,
	makeVercelPageviews,
} from '../testing/fakes'
import { runDiagnostics } from './diagnostics'

const NOW = new Date('2026-08-26T12:00:00Z')

function config(overrides: Partial<SiteAnalyticsConfig> = {}): SiteAnalyticsConfig {
	return {
		siteId: 'test',
		label: 'Test Foundry',
		ga4: { propertyId: '123456789', timezone: 'UTC' },
		vercel: { projectId: 'prj_test' },
		orders: { documentType: 'order', typefacesField: 'typefaces' },
		eventCutovers: { page_view: PREEXISTING, purchase: PREEXISTING },
		...overrides,
	}
}

/** Find one check by id. */
function check(report: Awaited<ReturnType<typeof runDiagnostics>>, id: string) {
	return report.checks.find((c) => c.id === id)
}

/**
 * A GA4 fake that answers each probe by the shape of the request, since diagnostics issues
 * several different single reports.
 */
function diagnosticGa4(overrides: {
	timeZone?: string
	recentSessions?: number
	oldSessions?: number
	events?: string[]
	transactionIds?: string[]
	purchases?: number
} = {}) {
	const {
		timeZone = 'UTC',
		recentSessions = 500,
		oldSessions = 100,
		events = ['page_view', 'purchase'],
		transactionIds = ['DS-1001'],
		purchases = 10,
	} = overrides

	return createFakeGa4Client({
		single: (request) => {
			const dims = (request.dimensions ?? []).map((d) => d.name)
			const start = request.dateRanges[0]?.startDate ?? ''

			if (dims.includes('eventName')) {
				return makeGa4Report(events.map((name) => ({ dimensions: [name], metrics: [50] })))
			}
			if (dims.includes('transactionId')) {
				return makeGa4Report(transactionIds.map((id) => ({ dimensions: [id], metrics: [1] })))
			}
			if (request.dimensionFilter) {
				return { ...makeGa4Total(purchases), timeZone }
			}
			// A plain sessions probe: the year-ago window starts much earlier than the 7-day one.
			const isOldWindow = start < '2026-06-01'
			return { ...makeGa4Total(isOldWindow ? oldSessions : recentSessions), timeZone }
		},
	})
}

describe('runDiagnostics', () => {
	it('passes cleanly on a healthy property', async () => {
		const report = await runDiagnostics({
			config: config(),
			ga4: diagnosticGa4(),
			vercel: createFakeVercelClient(makeVercelPageviews({ '2026-08-25': 900 })),
			sanity: createFakeSanityClient(() => makeOrders(Array(10).fill('2026-08-20'))),
			now: NOW,
		})

		expect(report.verdict).toBe('pass')
	})

	it('fails when the property timezone disagrees with the config', async () => {
		const report = await runDiagnostics({
			config: config({ ga4: { propertyId: '123456789', timezone: 'America/New_York' } }),
			ga4: diagnosticGa4({ timeZone: 'UTC' }),
			vercel: null,
			sanity: null,
			now: NOW,
		})

		const tz = check(report, 'ga4-timezone')
		expect(tz?.status).toBe('fail')
		expect(tz?.detail).toContain('America/New_York')
		expect(tz?.detail).toContain('UTC')
		expect(report.verdict).toBe('fail')
	})

	it('warns when nothing comes back from beyond the default retention window', async () => {
		// The exact symptom of a property left on 2-month retention.
		const report = await runDiagnostics({
			config: config(),
			ga4: diagnosticGa4({ oldSessions: 0 }),
			vercel: null,
			sanity: null,
			now: NOW,
		})

		const retention = check(report, 'ga4-retention')
		expect(retention?.status).toBe('warn')
		expect(retention?.remedy).toContain('14 months')
	})

	it('fails when the config claims an event is live that has never fired', async () => {
		const report = await runDiagnostics({
			// Config asserts begin_checkout is long-established; GA4 has never seen it.
			config: config({
				eventCutovers: { page_view: PREEXISTING, purchase: PREEXISTING, begin_checkout: PREEXISTING },
			}),
			ga4: diagnosticGa4({ events: ['page_view', 'purchase'] }),
			vercel: null,
			sanity: null,
			now: NOW,
		})

		const events = check(report, 'ga4-events')
		expect(events?.status).toBe('fail')
		expect(events?.detail).toContain('begin_checkout')
	})

	it('does not flag an event correctly marked as not yet instrumented', async () => {
		const report = await runDiagnostics({
			config: config({
				eventCutovers: { page_view: PREEXISTING, purchase: PREEXISTING, begin_checkout: null },
			}),
			ga4: diagnosticGa4({ events: ['page_view', 'purchase'] }),
			vercel: null,
			sanity: null,
			now: NOW,
		})

		expect(check(report, 'ga4-events')?.status).toBe('pass')
	})

	it('warns about events GA4 records that the config cannot report', async () => {
		const report = await runDiagnostics({
			config: config(),
			ga4: diagnosticGa4({ events: ['page_view', 'purchase', 'scroll', 'file_download'] }),
			vercel: null,
			sanity: null,
			now: NOW,
		})

		const unconfigured = check(report, 'ga4-unconfigured-events')
		expect(unconfigured?.status).toBe('warn')
		expect(unconfigured?.detail).toContain('scroll')
	})

	it('fails when purchases carry no usable transaction_id', async () => {
		const report = await runDiagnostics({
			config: config(),
			ga4: diagnosticGa4({ transactionIds: ['(not set)', '(not set)'] }),
			vercel: null,
			sanity: null,
			now: NOW,
		})

		const join = check(report, 'ga4-transaction-id')
		expect(join?.status).toBe('fail')
		expect(join?.remedy).toContain('orderNumber')
	})

	it('warns when GA4 purchases and Sanity orders diverge sharply', async () => {
		const report = await runDiagnostics({
			config: config(),
			// GA4 saw 10 purchases; Sanity has 40 orders.
			ga4: diagnosticGa4({ purchases: 10 }),
			vercel: null,
			sanity: createFakeSanityClient(() => makeOrders(Array(40).fill('2026-08-20'))),
			now: NOW,
		})

		const agreement = check(report, 'purchase-order-agreement')
		expect(agreement?.status).toBe('warn')
		expect(agreement?.detail).toContain('10')
		expect(agreement?.detail).toContain('40')
	})

	it('accepts a small divergence between purchases and orders', async () => {
		const report = await runDiagnostics({
			config: config(),
			ga4: diagnosticGa4({ purchases: 19 }),
			vercel: null,
			sanity: createFakeSanityClient(() => makeOrders(Array(20).fill('2026-08-20'))),
			now: NOW,
		})

		expect(check(report, 'purchase-order-agreement')?.status).toBe('pass')
	})

	it('reports a bad service account as a failure with an actionable remedy', async () => {
		const report = await runDiagnostics({
			config: config(),
			ga4: createFakeGa4Client({ failWith: new Error('GA4 runReport failed with 403') }),
			vercel: null,
			sanity: null,
			now: NOW,
		})

		const auth = check(report, 'ga4-auth')
		expect(auth?.status).toBe('fail')
		expect(auth?.remedy).toContain('Viewer')

		// Everything downstream of GA4 must skip rather than masquerade as passing.
		for (const id of ['ga4-timezone', 'ga4-retention', 'ga4-events', 'ga4-transaction-id']) {
			expect(check(report, id)?.status, id).toBe('skipped')
		}
	})

	it('skips rather than fails when a source is simply not configured', async () => {
		const report = await runDiagnostics({
			config: config({ ga4: null, vercel: null }),
			ga4: null,
			vercel: null,
			sanity: null,
			now: NOW,
		})

		expect(check(report, 'ga4-auth')?.status).toBe('skipped')
		expect(check(report, 'vercel')?.status).toBe('skipped')
		// Nothing was broken, only absent — the verdict must not read as a failure.
		expect(report.verdict).toBe('skipped')
	})
})
