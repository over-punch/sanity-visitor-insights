/**
 * Tests for the pure logic — the parts that decide whether a number is trustworthy.
 *
 * These deliberately need no credentials and no network. The reports themselves are thin wrappers
 * over API calls; the reasoning that can silently corrupt a figure lives here, in coverage
 * resolution, range anchoring and config validation.
 */

import { describe, expect, it } from 'vitest'
import { PREEXISTING, applyCoverage, coverageForRange, coverageNotices, type EventCutover } from './cutover'
import { RANGE_DAYS, daysBetween, formatInTimeZone, previousRange, provisionalNotice, resolveCustomRange, resolveRange, shiftDays } from './ranges'
import { validateSiteConfig } from './siteConfig'
import { zonedDayEndUtc, zonedDayStartUtc } from './ranges'
import { ENV_VARS, isEnabled } from '../server/createHandler'
import { valueOrNull } from '../types'

const cutovers: Record<string, EventCutover> = {
	page_view: PREEXISTING,
	begin_checkout: '2026-09-01',
	tester_engaged: null,
}

describe('coverageForRange', () => {
	it('reports full coverage for a pre-existing event', () => {
		expect(coverageForRange(cutovers, 'page_view', { start: '2020-01-01', end: '2026-08-26' })).toEqual({ status: 'full' })
	})

	it('reports no coverage for an event that is not instrumented', () => {
		expect(coverageForRange(cutovers, 'tester_engaged', { start: '2026-08-01', end: '2026-08-26' })).toEqual({
			status: 'none',
			reason: 'not_instrumented',
		})
	})

	it('distinguishes an unknown event from an uninstrumented one', () => {
		// An event the site does not have at all is a different statement from one that is pending.
		expect(coverageForRange(cutovers, 'trial_download', { start: '2026-08-01', end: '2026-08-26' })).toEqual({
			status: 'none',
			reason: 'unknown_event',
		})
	})

	it('reports no coverage when the range ends before the cutover', () => {
		expect(coverageForRange(cutovers, 'begin_checkout', { start: '2026-07-01', end: '2026-08-01' })).toEqual({
			status: 'none',
			reason: 'before_cutover',
			cutover: '2026-09-01',
		})
	})

	it('reports partial coverage when the range straddles the cutover', () => {
		expect(coverageForRange(cutovers, 'begin_checkout', { start: '2026-08-01', end: '2026-10-01' })).toEqual({
			status: 'partial',
			reason: 'spans_cutover',
			cutover: '2026-09-01',
			outages: [],
		})
	})

	it('treats an unparseable cutover as unknown rather than trusting it', () => {
		expect(coverageForRange({ bad: 'not-a-date' }, 'bad', { start: '2026-01-01', end: '2026-02-01' })).toEqual({
			status: 'none',
			reason: 'unknown_event',
		})
	})
})

describe('applyCoverage', () => {
	it('never turns an uninstrumented event into a zero', () => {
		const metric = applyCoverage(0, { status: 'none', reason: 'not_instrumented' })
		expect(metric.status).toBe('unavailable')
		expect(valueOrNull(metric)).toBeNull()
	})

	it('marks a straddling range as partial rather than complete', () => {
		const metric = applyCoverage(120, { status: 'partial', reason: 'spans_cutover', cutover: '2026-09-01', outages: [] })
		expect(metric.status).toBe('partial')
		expect(valueOrNull(metric)).toBe(120)
	})

	it('reports a failed query as a source error, not as zero', () => {
		const metric = applyCoverage(null, { status: 'full' })
		expect(metric).toEqual({ status: 'unavailable', reason: 'source_error', detail: undefined })
	})

	it('passes a real count through when coverage is full', () => {
		expect(applyCoverage(42, { status: 'full' })).toEqual({ status: 'ok', value: 42 })
	})
})

describe('coverageNotices', () => {
	it('explains every event that is not fully covered', () => {
		const notices = coverageNotices(cutovers, ['page_view', 'begin_checkout', 'tester_engaged'], {
			start: '2026-08-01',
			end: '2026-10-01',
		})

		expect(notices).toHaveLength(2)
		expect(notices.some((n) => n.includes('begin_checkout') && n.includes('2026-09-01'))).toBe(true)
		expect(notices.some((n) => n.includes('tester_engaged'))).toBe(true)
	})
})

describe('outages', () => {
	// Darden's real case: ecommerce events kept firing in code but stopped reaching GA4 for
	// nine months. Every one of those days returns an honest zero from the API.
	const withOutage: Record<string, EventCutover> = {
		purchase: {
			from: PREEXISTING,
			outages: [{ start: '2025-11-20', until: '2026-08-30', reason: 'gtag loader moved to lazyOnload' }],
		},
		still_broken: {
			from: PREEXISTING,
			outages: [{ start: '2026-01-01', until: null }],
		},
	}

	it('reports a range sitting entirely inside an outage as unavailable, not zero', () => {
		const coverage = coverageForRange(withOutage, 'purchase', { start: '2026-01-01', end: '2026-03-01' })
		expect(coverage.status).toBe('none')
		expect(coverage).toMatchObject({ reason: 'outage' })

		// The crucial assertion: a real GA4 zero must not become a charted zero.
		const metric = applyCoverage(0, coverage)
		expect(metric.status).toBe('unavailable')
		expect(valueOrNull(metric)).toBeNull()
	})

	it('reports a range straddling the end of an outage as partial and undercounted', () => {
		const coverage = coverageForRange(withOutage, 'purchase', { start: '2026-08-01', end: '2026-09-30' })
		expect(coverage).toMatchObject({ status: 'partial', reason: 'spans_outage' })

		const metric = applyCoverage(12, coverage)
		expect(metric.status).toBe('partial')
		if (metric.status === 'partial') expect(metric.note).toContain('Undercounted')
	})

	it('treats a range fully after the outage as complete', () => {
		expect(coverageForRange(withOutage, 'purchase', { start: '2026-09-01', end: '2026-09-30' })).toEqual({ status: 'full' })
	})

	it('treats a range fully before the outage as complete', () => {
		expect(coverageForRange(withOutage, 'purchase', { start: '2025-06-01', end: '2025-11-01' })).toEqual({ status: 'full' })
	})

	it('treats an unresolved outage as ongoing', () => {
		const coverage = coverageForRange(withOutage, 'still_broken', { start: '2026-06-01', end: '2026-08-30' })
		expect(coverage).toMatchObject({ status: 'none', reason: 'outage' })
	})

	it('still accepts the plain shorthand forms', () => {
		expect(coverageForRange({ a: PREEXISTING }, 'a', { start: '2026-01-01', end: '2026-02-01' })).toEqual({ status: 'full' })
		expect(coverageForRange({ a: null }, 'a', { start: '2026-01-01', end: '2026-02-01' })).toEqual({
			status: 'none', reason: 'not_instrumented',
		})
	})

	it('explains an outage in the notices rather than leaving a silent dip', () => {
		const notices = coverageNotices(withOutage, ['purchase'], { start: '2026-08-01', end: '2026-09-30' })
		expect(notices).toHaveLength(1)
		expect(notices[0]).toContain('not a real decline')
		expect(notices[0]).toContain('lazyOnload')
	})
})

describe('ranges', () => {
	it('anchors the range end to the property timezone, not the host timezone', () => {
		// 02:00 UTC on the 26th is still the 25th in Los Angeles. A range anchored to UTC would
		// silently include a day the GA4 property has not started yet.
		const instant = new Date('2026-08-26T02:00:00Z')
		expect(formatInTimeZone(instant, 'America/Los_Angeles')).toBe('2026-08-25')
		expect(formatInTimeZone(instant, 'UTC')).toBe('2026-08-26')
	})

	it('resolves a week as seven inclusive days', () => {
		const range = resolveRange('week', 'UTC', new Date('2026-08-26T12:00:00Z'))
		expect(range).toMatchObject({ key: 'week', start: '2026-08-20', end: '2026-08-26', timezone: 'UTC' })
		expect(daysBetween(range.start, range.end)).toBe(7)
	})

	it('produces a non-overlapping previous period of equal length', () => {
		const range = resolveRange('week', 'UTC', new Date('2026-08-26T12:00:00Z'))
		const previous = previousRange(range)

		expect(previous.end).toBe(shiftDays(range.start, -1))
		expect(daysBetween(previous.start, previous.end)).toBe(daysBetween(range.start, range.end))
	})

	it('warns when a range includes days GA4 has not finished processing', () => {
		const now = new Date('2026-08-26T12:00:00Z')
		const range = resolveRange('week', 'UTC', now)
		expect(provisionalNotice(range, now)).toContain('provisional')
	})

	it('stays silent when the range ends before the processing lag', () => {
		const range = { key: 'week' as const, start: '2026-01-01', end: '2026-01-07', timezone: 'UTC' }
		expect(provisionalNotice(range, new Date('2026-08-26T12:00:00Z'))).toBeNull()
	})
})

describe('validateSiteConfig', () => {
	const valid = {
		siteId: 'darden',
		label: 'Darden Studio',
		ga4: { propertyId: '123456789', timezone: 'America/New_York' },
		vercel: null,
		orders: { documentType: 'order', typefacesField: 'typefaces' },
		eventCutovers: {},
	}

	it('accepts a well-formed config', () => {
		expect(validateSiteConfig(valid)).toEqual([])
	})

	it('catches a measurement id pasted where the property id belongs', () => {
		// The single most likely misconfiguration, and one that would otherwise look like no traffic.
		const problems = validateSiteConfig({ ...valid, ga4: { propertyId: 'G-ABC123XYZ', timezone: 'UTC' } })
		expect(problems).toHaveLength(1)
		expect(problems[0]?.field).toBe('ga4.propertyId')
		expect(problems[0]?.message).toContain('numeric property id')
	})

	it('rejects a non-numeric property id', () => {
		const problems = validateSiteConfig({ ...valid, ga4: { propertyId: 'properties/123', timezone: 'UTC' } })
		expect(problems.some((p) => p.field === 'ga4.propertyId')).toBe(true)
	})

	it('rejects an unrecognised timezone', () => {
		const problems = validateSiteConfig({ ...valid, ga4: { propertyId: '123', timezone: 'Mars/Olympus' } })
		expect(problems.some((p) => p.field === 'ga4.timezone')).toBe(true)
	})

	it('rejects a studio origin with a trailing slash or no scheme', () => {
		const problems = validateSiteConfig({ ...valid, allowedStudioOrigins: ['mckl.sanity.studio', 'https://x.sanity.studio/'] })
		expect(problems.filter((p) => p.field === 'allowedStudioOrigins')).toHaveLength(2)
	})

	it('reports every problem at once rather than one per run', () => {
		expect(validateSiteConfig({}).length).toBeGreaterThan(1)
	})
})

describe('vercel granularity', () => {
	it('picks a granularity the API will actually accept', async () => {
		const { granularityFor } = await import('../server/vercel')
		// Limits measured against the live API: day caps at 62 days, week at 26 weeks. Exceeding
		// either is a 400, not a truncated series, so the year view fails outright if this is wrong.
		expect(granularityFor('2026-08-01', '2026-08-30')).toBe('day')
		expect(granularityFor('2026-07-01', '2026-08-31')).toBe('day')
		expect(granularityFor('2026-06-01', '2026-08-30')).toBe('week')
		// Exact boundaries: 62 days is still day, 63 is not; 182 days is still week, 183 is not.
		expect(granularityFor('2026-01-01', '2026-03-03')).toBe('day')
		expect(granularityFor('2026-01-01', '2026-03-04')).toBe('week')
		expect(granularityFor('2026-01-01', '2026-07-01')).toBe('week')
		expect(granularityFor('2026-01-01', '2026-07-02')).toBe('month')
		expect(granularityFor('2025-08-30', '2026-08-30')).toBe('month')
	})
})

describe('site caveats', () => {
	it('accepts declared measurement quirks on the config', () => {
		const problems = validateSiteConfig({
			siteId: 'mckl', label: 'MCKL',
			ga4: { propertyId: '361046782', timezone: 'UTC' },
			orders: { documentType: 'order', typefacesField: 'typefaces' },
			eventCutovers: {},
			caveats: ['add_to_cart fires on every selection change here, not on a discrete cart action.'],
		})
		expect(problems).toEqual([])
	})
})

describe('named ranges', () => {
	// The set is the whole selector: adding a key here without a day count would silently resolve
	// to NaN days and produce an Invalid Date start.
	it('gives every selectable range a day count', () => {
		expect(RANGE_DAYS).toEqual({ week: 7, month: 30, quarter: 91, year: 365 })
	})

	it('anchors month to the trailing 30 days ending today', () => {
		const range = resolveRange('month', 'UTC', new Date('2026-08-26T12:00:00Z'))
		expect(range).toMatchObject({ key: 'month', start: '2026-07-28', end: '2026-08-26' })
	})
})

describe('resolveCustomRange', () => {
	const now = new Date('2026-08-26T12:00:00Z')

	it('accepts a well-formed past range', () => {
		expect(resolveCustomRange('2026-06-01', '2026-06-30', 'UTC', now)).toEqual({
			range: { key: 'custom', start: '2026-06-01', end: '2026-06-30', timezone: 'UTC' },
		})
	})

	it('accepts a single day', () => {
		const result = resolveCustomRange('2026-06-01', '2026-06-01', 'UTC', now)
		expect(result).toHaveProperty('range')
	})

	it('refuses anything that is not YYYY-MM-DD', () => {
		// GA4 would accept "2026-6-1" for some values and reject others; refusing here means the
		// reader is told what to change rather than seeing an opaque 502.
		expect(resolveCustomRange('01/06/2026', '2026-06-30', 'UTC', now)).toHaveProperty('error')
		expect(resolveCustomRange('', '', 'UTC', now)).toHaveProperty('error')
	})

	it('refuses an inverted range rather than returning an empty report', () => {
		// The failure mode this exists to prevent: GA4 answers an inverted range with zero rows,
		// which renders identically to a site nobody visited.
		expect(resolveCustomRange('2026-06-30', '2026-06-01', 'UTC', now)).toEqual({
			error: 'The end date is before the start date.',
		})
	})

	it('refuses a future end date and names the latest day available', () => {
		const result = resolveCustomRange('2026-08-01', '2026-12-01', 'UTC', now)
		expect(result).toHaveProperty('error')
		expect((result as { error: string }).error).toContain('2026-08-26')
	})

	it('resolves today against the property timezone, not the reader\'s', () => {
		// 2026-08-26T12:00Z is already the 26th in London and still the 26th in Los Angeles, but
		// at 03:00Z it is the 25th in LA. A Studio open in London must not be able to ask an LA
		// property for a day that has not started there.
		const earlyMorning = new Date('2026-08-26T03:00:00Z')
		expect(resolveCustomRange('2026-08-20', '2026-08-26', 'Europe/London', earlyMorning)).toHaveProperty('range')
		expect(resolveCustomRange('2026-08-20', '2026-08-26', 'America/Los_Angeles', earlyMorning)).toHaveProperty('error')
	})

	it('caps the span', () => {
		expect(resolveCustomRange('2020-01-01', '2026-08-26', 'UTC', now)).toHaveProperty('error')
	})
})

describe('the master switch', () => {
	it('is off when the variable is unset', () => {
		// Explicit opt-in, unlike the sales portal's kill switch. Installing the package and
		// mounting the route must not be enough to start serving analytics from a site nobody
		// switched it on for.
		expect(isEnabled(undefined)).toBe(false)
	})

	it('is off for the words an operator would use to mean off', () => {
		for (const value of ['', ' ', 'false', 'FALSE', '0', 'off', 'no', 'disabled', ' False ']) {
			expect(isEnabled(value), `expected ${JSON.stringify(value)} to read as off`).toBe(false)
		}
	})

	it('is on for any other value, so any code the operator picks works', () => {
		for (const value of ['true', '1', 'yes', 'on', 'enabled', 'darden-2026', 'TRUE']) {
			expect(isEnabled(value), `expected ${JSON.stringify(value)} to read as on`).toBe(true)
		}
	})

	it('names the variable it reads, so all three sites can be configured alike', () => {
		expect(ENV_VARS.enabled).toBe('VISITOR_INSIGHTS_ENABLED')
	})
})

describe('zoned day boundaries', () => {
	it('resolves a day start to the right UTC instant in a western zone', () => {
		// Pacific daylight time is UTC-7, so 20 August begins at 07:00Z.
		expect(zonedDayStartUtc('2026-08-20', 'America/Los_Angeles')).toBe('2026-08-20T07:00:00.000Z')
	})

	it('resolves a day start in an eastern zone', () => {
		// Tokyo is UTC+9 year round, so the day begins the previous afternoon in UTC.
		expect(zonedDayStartUtc('2026-08-20', 'Asia/Tokyo')).toBe('2026-08-19T15:00:00.000Z')
	})

	it('is the identity for UTC', () => {
		expect(zonedDayStartUtc('2026-08-20', 'UTC')).toBe('2026-08-20T00:00:00.000Z')
	})

	it('ends a day at the start of the next, exclusive', () => {
		// Exclusive so the last second cannot be dropped, and so a 23- or 25-hour DST day is still
		// bounded correctly — which a hard-coded 23:59:59 cannot do.
		expect(zonedDayEndUtc('2026-08-26', 'UTC')).toBe('2026-08-27T00:00:00.000Z')
	})

	it('handles the spring-forward day, which is only 23 hours long', () => {
		// US DST began 8 March 2026. The day starts at UTC-8 and ends at UTC-7.
		expect(zonedDayStartUtc('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-08T08:00:00.000Z')
		expect(zonedDayEndUtc('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-09T07:00:00.000Z')
	})

	it('handles the autumn fall-back day, which is 25 hours long', () => {
		// US DST ended 1 November 2026.
		expect(zonedDayStartUtc('2026-11-01', 'America/Los_Angeles')).toBe('2026-11-01T07:00:00.000Z')
		expect(zonedDayEndUtc('2026-11-01', 'America/Los_Angeles')).toBe('2026-11-02T08:00:00.000Z')
	})
})

describe('config validation additions', () => {
	const base = {
		siteId: 'test',
		label: 'Test',
		vercel: null,
		orders: { documentType: 'order', typefacesField: null },
		eventCutovers: {},
	}

	it('rejects a hostname written as a URL', () => {
		// A scheme or path here silently matches nothing, because GA4's hostName is the bare host —
		// so the whole tool would report zero rather than fail.
		const problems = validateSiteConfig({
			...base,
			ga4: { propertyId: '123', timezone: 'UTC', hostnames: ['https://www.dardenstudio.com'] },
		})
		expect(problems.some((p) => p.field === 'ga4.hostnames')).toBe(true)
	})

	it('accepts bare hostnames', () => {
		const problems = validateSiteConfig({
			...base,
			ga4: { propertyId: '123', timezone: 'UTC', hostnames: ['www.dardenstudio.com', 'dardenstudio.com'] },
		})
		expect(problems).toEqual([])
	})

	it('rejects an empty status allow-list, which would exclude every order', () => {
		const problems = validateSiteConfig({
			...base,
			ga4: null,
			orders: { documentType: 'order', typefacesField: null, countedStatuses: [] },
		})
		expect(problems.some((p) => p.field === 'orders.countedStatuses')).toBe(true)
	})
})
