/**
 * Tests for the pure logic — the parts that decide whether a number is trustworthy.
 *
 * These deliberately need no credentials and no network. The reports themselves are thin wrappers
 * over API calls; the reasoning that can silently corrupt a figure lives here, in coverage
 * resolution, range anchoring and config validation.
 */

import { describe, expect, it } from 'vitest'
import { PREEXISTING, applyCoverage, coverageForRange, coverageNotices, type EventCutover } from './cutover'
import { daysBetween, formatInTimeZone, previousRange, provisionalNotice, resolveRange, shiftDays } from './ranges'
import { validateSiteConfig } from './siteConfig'
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
