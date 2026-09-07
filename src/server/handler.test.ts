/**
 * Tests that drive the request handler itself.
 *
 * Every other test in this package injects a fake client and calls a report function directly, so
 * nothing had ever exercised what the handler does around them: parsing the query, choosing a
 * comparison window, and — the reason this file exists — building the cache key. A key that omits
 * a parameter the answer depends on is invisible to a report test and to the type checker, and
 * shows up only as one reader being served another reader's answer.
 *
 * The upstreams are all left unconfigured. The metrics come back unavailable, which is exactly
 * enough: the envelope's shape, its comparison window and its basis are what is under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREEXISTING } from '../core/cutover'
import { clearCache } from './cache'
import { createVisitorInsightsHandler, ENV_VARS } from './createHandler'
import type { SiteAnalyticsConfig } from '../core/siteConfig'

/** A site with no upstream configured — enough to answer, nothing to fetch. */
const config: SiteAnalyticsConfig = {
	siteId: 'test',
	label: 'Test Foundry',
	ga4: null,
	vercel: null,
	// A document type is required even with no Sanity client — nothing here queries it.
	orders: { documentType: 'order', typefacesField: null },
	eventCutovers: {
		page_view: PREEXISTING, view_item: PREEXISTING, add_to_cart: PREEXISTING,
		begin_checkout: PREEXISTING, purchase: PREEXISTING, tester_engaged: PREEXISTING,
		consent_granted: PREEXISTING,
	},
}

/** Captures whatever the handler sends, in the shape it expects to write to. */
function recorder() {
	const sent: { status: number; body: unknown } = { status: 0, body: null }
	const res = {
		status(code: number) { sent.status = code; return res },
		json(body: unknown) { sent.body = body },
		setHeader() { /* CORS */ },
		end() { /* preflight */ },
	}
	return { res: res as never, sent }
}

/** One GET, with the query the Studio would send. */
function request(query: Record<string, string>) {
	return {
		method: 'GET',
		url: '/api/visitor-insights',
		query,
		headers: { authorization: 'Bearer studio-session-token' },
	} as never
}

describe('the comparison basis reaches the cache key', () => {
	beforeEach(() => {
		clearCache()
		process.env[ENV_VARS.enabled] = '1'
		process.env.SANITY_STUDIO_PROJECT_ID = 'proj'
		// Only the Studio token check reaches the network here.
		globalThis.fetch = (async () => ({
			ok: true, status: 200, async json() { return { id: 'user-1', roles: [] } },
		})) as unknown as typeof fetch
	})

	afterEach(() => {
		delete process.env[ENV_VARS.enabled]
		delete process.env.SANITY_STUDIO_PROJECT_ID
		vi.restoreAllMocks()
	})

	it('answers the second reader with their own baseline, not the first reader\'s', async () => {
		// The two requests differ ONLY in `compare`. With the basis missing from the key the second
		// is served the first's cached envelope: deltas measured against the preceding window,
		// labelled in the panel as against last year.
		const handler = createVisitorInsightsHandler({ config })

		const first = recorder()
		await handler(request({ report: 'measurement-health', range: 'quarter' }), first.res)
		const second = recorder()
		await handler(request({ report: 'measurement-health', range: 'quarter', compare: 'same-period-last-year' }), second.res)

		expect(first.sent.status).toBe(200)
		expect(second.sent.status).toBe(200)

		const basisOf = (body: unknown) => (body as { comparison?: { basis?: string } }).comparison?.basis
		const windowOf = (body: unknown) => (body as { comparison?: { range?: { start?: string } } }).comparison?.range?.start

		expect(basisOf(first.sent.body)).toBe('previous-period')
		expect(basisOf(second.sent.body)).toBe('same-period-last-year')
		// And the window really moved — a label alone would be the same bug wearing the right name.
		expect(windowOf(second.sent.body)).not.toBe(windowOf(first.sent.body))
	})

	it('serves a repeat of the same request from cache', async () => {
		// The other half of the same property: the key must still collapse identical requests, or
		// including the basis would have been paid for with a fresh fan-out on every keystroke.
		const handler = createVisitorInsightsHandler({ config })
		const first = recorder()
		await handler(request({ report: 'measurement-health', range: 'quarter' }), first.res)
		const again = recorder()
		await handler(request({ report: 'measurement-health', range: 'quarter' }), again.res)
		expect(again.sent.body).toBe(first.sent.body)
	})

	it('treats an unrecognised basis as the default rather than as a third window', async () => {
		// The value arrives in a query string. Anything that is not the one alternative reads as the
		// baseline the tool has always used.
		const handler = createVisitorInsightsHandler({ config })
		const odd = recorder()
		await handler(request({ report: 'measurement-health', range: 'quarter', compare: 'last-tuesday' }), odd.res)
		expect((odd.sent.body as { comparison?: { basis?: string } }).comparison?.basis).toBe('previous-period')
	})
})
