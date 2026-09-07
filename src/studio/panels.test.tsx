/**
 * Render tests for the panels.
 *
 * Until these existed, no panel in this package had ever rendered — the logic was covered and the
 * types checked, but a component that throws on an unavailable metric would have shipped unnoticed.
 * The test-studio preview was meant to cover this interactively; its build is blocked by unrelated
 * problems in sibling plugins, and in any case an interactive preview proves nothing in CI.
 *
 * These render to static markup, which needs no DOM and no Studio. That is enough to catch the
 * failures that actually matter here: a panel throwing on an absent value, and — more insidious —
 * an unavailable metric rendering as "0" and being read as a real measurement.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { calendarDays } from '../server/reports/measurementHealth'
import { dailyWindows } from '../server/vercel'
import { zonedDay } from '../server/orders'
import { formatInTimeZone } from '../core/ranges'
import { formatCount, formatMoney } from './Figure'
import { decodeView, encodeView, mergeIntoHash } from './urlState'
import { captureModel, fromOrders, fromPageviews, grossUp } from '../core/capture'
import { forgetShortfalls, knownShortfall, rememberShortfall } from './useReport'
import { CrossSourceTimeline, dayIndexAt, findCoverageIncident } from './CrossSourceTimeline'
import React from 'react'
import {
	AcquisitionPanel,
	DiagnosticsPanel,
	JourneyPanel,
	OverviewPanel,
	DataHealthPanel,
	TypefaceInterestPanel,
	buyRateIndex,
	catalogueRate,
	coverageOf,
	gapOf,
} from './panels'
import { PanelBoundary, ReadyReport, VisitorInsightsTool } from './VisitorInsightsTool'

// The tool mounts a panel, and the panel's hook calls useClient(), which needs a Studio source
// context these tests deliberately do not build. The contract under test is the props shape, so the
// client is stubbed with a token present — enough for the hook to get past its own guards and
// attempt a fetch, which never resolves here and does not need to.
vi.mock('sanity', () => ({
	useClient: () => ({ config: () => ({ token: 'test-token' }) }),
	definePlugin: (definition: unknown) => definition,
}))
import visitorInsights from '../index'
import { Delta, FunnelChart, MetricFigure, NoticeList, ProportionChart, SortableTable } from './Figure'
import { holdsPreviousAnswer } from './useReport'
import { ok, partial, unavailable } from '../types'
import { UI } from '@liiift-studio/sanity-ui-compat'

// @sanity/ui primitives read their palette from theme context and throw without it. Reached through
// the compat namespace rather than a direct import, because @sanity/ui v4 declares its barrel
// exports as `never` — they exist at runtime but not to the type checker, which is the whole reason
// sanity-ui-compat exists.
const ThemeProvider = (UI as Record<string, unknown>).ThemeProvider as React.ComponentType<{
	theme: unknown
	children: React.ReactNode
}>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const theme = (require('@sanity/ui/theme') as { buildTheme: () => unknown }).buildTheme()

/**
 * Render an element to markup inside a theme, failing loudly rather than producing nothing.
 * Static markup needs no DOM, so this runs anywhere the unit tests do.
 */
function render(element: React.ReactElement): string {
	const html = renderToStaticMarkup(<ThemeProvider theme={theme}>{element}</ThemeProvider>)
	expect(html.length).toBeGreaterThan(0)
	return html
}

describe('MetricFigure', () => {
	it('renders an available number', () => {
		expect(render(<MetricFigure metric={ok(1234)} label="Views" />)).toContain('1,234')
	})

	it('renders an unavailable metric as a dash and never as zero', () => {
		const html = render(<MetricFigure metric={unavailable('not_instrumented')} label="Views" />)
		expect(html).toContain('—')
		// The whole point: absent must not be indistinguishable from a measured zero.
		expect(html).not.toMatch(/>0</)
	})

	it('states the reason for every unavailable variant, as real text', () => {
		// This asserted the presence of an `aria-label` — which was the BROKEN mechanism. Text puts
		// it on a <div>, whose role is generic, where aria-label is prohibited and ignored; the only
		// other content was an aria-hidden dash. So an unavailable metric announced as an empty
		// node, and this test passed the whole time because the attribute was in the markup.
		//
		// The assertion is now on announceable text, which is the thing that was missing.
		const reasons = ['not_instrumented', 'before_cutover', 'suppressed', 'outage', 'source_error', 'not_applicable'] as const
		for (const reason of reasons) {
			const html = render(<MetricFigure metric={unavailable(reason)} label="Views" />)
			expect(html, reason).toContain('Views: unavailable.')
			// And the text is present but not visible, rather than being an attribute.
			expect(html, reason).toContain('position:absolute')
		}
	})

	it('announces an estimate as an estimate rather than as a figure', () => {
		const html = render(
			<MetricFigure metric={{ status: 'estimated', value: 714, low: 595, high: 892, basis: 'GA4 sees about half.' }} label="Sessions" />,
		)
		expect(html).toContain('estimated, between')
		// The tilde is decoration and must not be read out as part of the number.
		expect(html).toContain('aria-hidden="true">~')
	})

	it('marks a partial value as partial while still showing the number', () => {
		const html = render(<MetricFigure metric={partial(120, '2026-09-01', 'Undercounted: outage')} label="Purchases" />)
		expect(html).toContain('120')
		expect(html).toContain('Partial')
	})
})

describe('NoticeList', () => {
	it('renders nothing when there are no caveats', () => {
		expect(renderToStaticMarkup(<NoticeList notices={[]} />)).toBe('')
	})

	it('renders each caveat as a list item', () => {
		const html = render(<NoticeList notices={['first caveat', 'second caveat']} />)
		expect(html).toContain('first caveat')
		expect(html).toContain('second caveat')
		expect((html.match(/<li/g) ?? []).length).toBe(2)
	})
})

describe('MeasurementHealthPanel', () => {
	it('renders when every source answered', () => {
		const html = render(
			<DataHealthPanel
				data={{
					ga4Pageviews: ok(33486), vercelPageviews: ok(33597), shortfallRatio: 0.0033,
					ga4Sessions: ok(22781), orders: ok(64), consentRate: ok(78.4),
					vercelVisitors: ok(21400), vercelDailyUnavailable: false,
					revenue: ok(4820), currency: 'USD', orderStatuses: { verified: 60, refunded: 4 },
					capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable'),
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
					interpretation: 'Sources agree.', daily: [],
				}}
			/>,
		)
		expect(html).toContain('33,486')
		expect(html).toContain('Sources agree.')
	})

	it('renders when GA4 is dead without inventing a shortfall', () => {
		const html = render(
			<DataHealthPanel
				data={{
					ga4Pageviews: unavailable('source_error'), vercelPageviews: ok(2620), shortfallRatio: null,
					ga4Sessions: unavailable('source_error'), orders: ok(12), consentRate: unavailable('source_error'),
					vercelVisitors: ok(1730), vercelDailyUnavailable: false,
					revenue: unavailable('source_error'), currency: null, orderStatuses: {},
					capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable'),
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
					daily: [],
			interpretation: 'Only one pageview source answered.',
				}}
			/>,
		)
		expect(html).toContain('2,620')
		expect(html).toContain('Only one pageview source answered.')
		// No percentage may be shown when there is nothing to compare against.
		expect(html).not.toContain('shortfall')
	})
})

describe('JourneyPanel', () => {
	const data = {
		approximate: true as const,
		approximationNote: 'Independent per-step totals, not tracked journeys.',
		steps: [
			{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(33486), conversionFromPrevious: null },
			{ key: 'tested', label: 'Used the type tester', event: 'tester_engaged', count: unavailable('not_instrumented'), conversionFromPrevious: null },
			{ key: 'began_checkout', label: 'Began checkout', event: 'begin_checkout', count: unavailable('outage', 'not recorded 2025-11-20 onwards'), conversionFromPrevious: null },
			{ key: 'purchased', label: 'Purchased', event: 'purchase', count: partial(64, '2026-08-30', 'Undercounted: outage'), conversionFromPrevious: 0.035 },
		],
		topLandingPages: [{ path: '/', sessions: 8940, engagedSessions: 6100, engagementRate: 0.682 }],
		outcomes: [],
		measurement: 'independent-totals' as const,
	}

	it('renders a funnel mixing working, uninstrumented and outage rungs', () => {
		const html = render(<JourneyPanel data={data} />)
		expect(html).toContain('Landed')
		// Uninstrumented rungs are no longer drawn as empty rails between real ones — an unmeasured
		// step implied a drop-off that was never observed. They are named beneath instead.
		expect(html).not.toContain('>Used the type tester<')
		expect(html).toContain('Not shown')
		expect(html).toContain('used the type tester')
		expect(html).toContain('33,486')
	})

	it('never draws an unmeasured step as a funnel rung', () => {
		const html = render(<JourneyPanel data={data} />)
		// The failure this guards: a zero-width or zero-valued rung reads as "nobody reached this
		// step", which is the opposite of "we did not measure it". Both unmeasured steps must
		// appear only in the prose beneath.
		expect(html).not.toContain('>Began checkout<')
		expect(html).toContain('began checkout')
		expect(html).not.toMatch(/>0</)
	})

	it('names the fallback as independent totals and keeps the caution', () => {
		const html = render(<JourneyPanel data={data} />)
		expect(html).toContain('Independent per-step totals')
		expect(html).toContain('not tracked journeys')
		// Cautionary tone, because independent totals invite a drop-off reading they cannot support.
		expect(html).toContain('caution')
		// And the gaps between rungs are differences, not people who left.
		expect(html).toContain('fewer')
		expect(html).not.toContain('did not continue')
	})

	it('presents a tracked funnel as a sequence rather than as a caveat', () => {
		const tracked = {
			...data,
			approximate: false as const,
			approximationNote: 'A tracked funnel. Each step counts users who reached it having completed the earlier steps.',
			measurement: 'sequence' as const,
			steps: [
				{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(1000), conversionFromPrevious: null },
				{ key: 'added_to_cart', label: 'Added to cart', event: 'add_to_cart', count: ok(60), conversionFromPrevious: 0.06 },
			],
		}

		const html = render(<JourneyPanel data={tracked} />)
		expect(html).toContain('Tracked funnel')
		// A real sequence is not a caveat, so it must not be dressed as one.
		expect(html).not.toContain('caution')
		expect(html).toContain('did not continue')
		// Each rung states its share of entry as well as of the step before it.
		expect(html).toContain('6.0% of landed')
	})

	it('scales rungs against the entry step, not against the largest', () => {
		// The fallback can report a mid-funnel step above entry (add_to_cart fires per selection
		// on two of the three sites). Anchoring to the max would make that step full-width and
		// silently rescale everything above it; the width is clamped at 100% instead.
		const inflated = {
			...data,
			steps: [
				{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(100), conversionFromPrevious: null },
				{ key: 'added_to_cart', label: 'Added to cart', event: 'add_to_cart', count: ok(500), conversionFromPrevious: 5 },
			],
		}

		const html = render(<JourneyPanel data={inflated} />)
		// Both bars are drawn at full width — the second is clamped, not rescaled.
		// Both bars full width — the second is clamped, not rescaled. Matched on the fill's own
		// declaration now that bars are explicit styles rather than Card tones.
		expect(html.match(/opacity:0\.55;width:100%/g)).toHaveLength(2)
		// But the printed share is NOT clamped. Showing "100.0%" here would hide the anomaly.
		expect(html).toContain('500.0% of landed')
		// And a step larger than the one above it is named as such, not as "no difference".
		expect(html).toContain('400 more')
		expect(html).not.toContain('no difference')
	})

	it('does not print the same ratio twice on the second rung', () => {
		// On stage two the previous step IS the entry step, so both ratios have the same
		// denominator and the row read "100.0% of landed · 500.0% of landed".
		const html = render(<JourneyPanel data={{
			...data,
			steps: [
				{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(1000), conversionFromPrevious: null },
				{ key: 'added_to_cart', label: 'Added to cart', event: 'add_to_cart', count: ok(60), conversionFromPrevious: 0.06 },
			],
		}} />)
		expect(html.match(/of landed/g)).toHaveLength(1)
	})
})

describe('AcquisitionPanel', () => {
	it('renders sources and flags the special segments', () => {
		const html = render(
			<AcquisitionPanel
				data={{
					totalSessions: 1000, designIndustryShare: 0.3, unattributedShare: 0.1, rowsWithheld: true, rowsTruncated: false,
					rows: [
						{ source: 'fontsinuse.com', channel: 'Referral', medium: null, campaign: null, sessions: 300, engagedSessions: null, engagementRate: null, designIndustry: true, unattributed: false },
						{ source: '(not set)', channel: 'Unassigned', medium: null, campaign: null, sessions: 100, engagedSessions: null, engagementRate: null, designIndustry: false, unattributed: true },
					],
				}}
			/>,
		)
		expect(html).toContain('fontsinuse.com')
		expect(html).toContain('design-industry')
		expect(html).toContain('Unattributed')
		// Withheld rows must be admitted, or the list reads as exhaustive.
		expect(html).toContain('withheld')
	})

	it('links a real referrer host, and does not link GA4 buckets', () => {
		const html = render(
			<AcquisitionPanel
				data={{
					totalSessions: 1000, designIndustryShare: 0.3, unattributedShare: 0.1,
					rowsWithheld: false, rowsTruncated: false,
					rows: [
						{ source: 'fontsinuse.com', channel: 'Referral', medium: null, campaign: null, sessions: 300, engagedSessions: null, engagementRate: null, designIndustry: true, unattributed: false },
						{ source: '(direct)', channel: 'Direct', medium: null, campaign: null, sessions: 100, engagedSessions: null, engagementRate: null, designIndustry: false, unattributed: true },
					],
				}}
			/>,
		)
		expect(html).toContain('href="https://fontsinuse.com"')
		// (direct) is a GA4 bucket, not a host. A dead https://(direct) would erode trust in every
		// other link on the page.
		expect(html).not.toContain('https://(direct)')
		// External links open safely.
		expect(html).toContain('rel="noopener noreferrer"')
	})

	it('marks columns as sortable and states the active sort', () => {
		const html = render(
			<AcquisitionPanel
				data={{
					totalSessions: 400, designIndustryShare: null, unattributedShare: null,
					rowsWithheld: false, rowsTruncated: false,
					rows: [
						{ source: 'fontsinuse.com', channel: 'Referral', medium: null, campaign: null, sessions: 300, engagedSessions: null, engagementRate: null, designIndustry: true, unattributed: false },
					],
				}}
			/>,
		)
		// Sessions leads, descending, and the other columns advertise that they sort too.
		expect(html).toContain('aria-sort="descending"')
		expect(html).toContain('aria-sort="none"')
	})
})

describe('TypefaceInterestPanel', () => {
	it('renders mixed availability across columns', () => {
		const html = render(
			<TypefaceInterestPanel
				data={{
					rowsWithheld: false, rowsTruncated: false, revenueIsApportioned: true, currency: 'USD', licences: [],
					interpretationNote: 'Aggregate interest per family, not individual journeys.',
					rows: [
						{ typeface: 'Omnes', viewed: ok(3792), tested: ok(910), bought: ok(21), revenue: ok(6300), buyRate: 0.0055, testRate: 0.24 },
						{ typeface: 'Gamay', viewed: ok(1040), tested: unavailable('not_instrumented'), bought: unavailable('not_applicable'), revenue: unavailable('not_applicable'), buyRate: null, testRate: null },
					],
				}}
			/>,
		)
		expect(html).toContain('Omnes')
		expect(html).toContain('Gamay')
		expect(html).toContain('3,792')
		expect(html).toContain('not individual journeys')
	})
})

describe('DiagnosticsPanel', () => {
	it('renders every check status', () => {
		const html = render(
			<DiagnosticsPanel
				data={{
					verdict: 'fail',
					checks: [
						{ id: 'a', label: 'GA4 reachable', status: 'pass', detail: 'Answered.' },
						{ id: 'b', label: 'Timezone matches config', status: 'fail', detail: 'Mismatch.', remedy: 'Set ga4.timezone.' },
						{ id: 'c', label: 'No unreportable events', status: 'warn', detail: 'Extra events.' },
						{ id: 'd', label: 'Purchases carry transaction_id', status: 'skipped', detail: 'None to inspect.' },
					],
				}}
			/>,
		)
		for (const word of ['Pass', 'Fail', 'Check', 'Skipped']) expect(html, word).toContain(word)
		// The remedy is the actionable half; rendering the fault without it would be half a report.
		expect(html).toContain('Set ga4.timezone.')
	})

	it('renders a clean verdict without failure language', () => {
		const html = render(
			<DiagnosticsPanel data={{ verdict: 'pass', checks: [{ id: 'a', label: 'GA4 reachable', status: 'pass', detail: 'Answered.' }] }} />,
		)
		// Scoped wording. "Everything checked out" was a blanket endorsement covering statistical
		// validity, sampling and small denominators that these plumbing checks never test.
		expect(html).toContain('Configuration and credentials check out')
		expect(html).toContain('not whether the figures are worth trusting')
	})
})

/**
 * The tool component's props contract.
 *
 * These exist because the tool shipped broken and the whole suite stayed green. Sanity does NOT
 * spread a tool's `options` onto its component — it passes the tool definition as `tool`, with the
 * options nested. The component destructured `apiBaseUrl` straight off props, so it was always
 * undefined in a real Studio, and the first thing useReport did with it was call `.replace()`.
 * Every panel rendered "Cannot read properties of undefined (reading 'replace')".
 *
 * Nothing caught it because no test ever mounted this component, and the plugin's own tool
 * definition was never exercised. Passing props in the shape the code expected would have proved
 * nothing either — the shape was the bug. So these mount it the way the Studio does.
 */
describe('VisitorInsightsTool props contract', () => {
	it('reads options from the nested tool prop, the way Sanity passes them', () => {
		const html = render(
			React.createElement(VisitorInsightsTool, {
				tool: { options: { apiBaseUrl: 'https://example.com', siteLabel: 'Example Foundry' } },
			}),
		)
		// The name is not printed as a subtitle any more; it names the region for assistive tech,
		// which is still evidence the nested options reached the component.
		expect(html).toContain('Visitor insights for Example Foundry')
	})

	it('still accepts flat props, for direct use outside a Studio', () => {
		const html = render(
			React.createElement(VisitorInsightsTool, {
				apiBaseUrl: 'https://example.com',
				siteLabel: 'Flat Props Foundry',
			}),
		)
		expect(html).toContain('Visitor insights for Flat Props Foundry')
	})

	it('renders rather than throwing when no options arrive at all', () => {
		// A misconfigured plugin should show its shell and let the panel report the failure, not
		// take the whole tab down with a stack trace.
		expect(() => render(React.createElement(VisitorInsightsTool, {}))).not.toThrow()
	})
})

/**
 * The plugin's tool definition must carry the options the component reads.
 *
 * The two halves were written separately and never checked against each other: the plugin put
 * options on the tool, the component looked for them on props, and both were internally consistent.
 */
describe('plugin tool definition', () => {
	it('puts apiBaseUrl and siteLabel in tool.options', () => {
		const plugin = visitorInsights({ apiBaseUrl: 'https://example.com', siteLabel: 'Example Foundry' })
		const toolsHook = (plugin as unknown as { tools?: unknown }).tools
			?? ((plugin as unknown as { plugins?: Array<{ tools?: unknown }> }).plugins ?? [])
				.map((p) => p?.tools).find(Boolean)

		const resolve = typeof toolsHook === 'function'
			? (toolsHook as (prev: unknown[], ctx: unknown) => Array<{ name: string; options?: Record<string, unknown> }>)
			: null
		expect(resolve).toBeTypeOf('function')

		const tools = resolve!([], { currentUser: { roles: [{ name: 'administrator' }] } })
		const tool = tools.find((t) => t.name === 'visitor-insights')
		expect(tool).toBeDefined()
		expect(tool?.options?.apiBaseUrl).toBe('https://example.com')
		expect(tool?.options?.siteLabel).toBe('Example Foundry')
	})
})

/**
 * Units on figures.
 *
 * MetricValue carries availability but not unit, so a percentage and a count reach MetricFigure
 * indistinguishable. The consent rate is a 0-100 percentage and was rendered with the count
 * formatter: "84.3" became "84", sitting in a row beside "GA4 sessions 357" and "Orders 7" where
 * the natural reading is 84 of 357. The missing suffix inverted the conclusion — 84% consent read
 * as 24%.
 */
describe('MetricFigure units', () => {
	it('writes a percentage with its sign and keeps one decimal', () => {
		const html = render(<MetricFigure metric={ok(84.3)} label="Consent granted" unit="percent" />)
		expect(html).toContain('84.3%')
	})

	it('does not round a percentage into a bare integer', () => {
		const html = render(<MetricFigure metric={ok(84.3)} label="Consent granted" unit="percent" />)
		expect(html).not.toMatch(/>84</)
	})

	it('still formats counts with thousands separators and no suffix', () => {
		const html = render(<MetricFigure metric={ok(2356)} label="Vercel pageviews" />)
		expect(html).toContain('2,356')
		expect(html).not.toContain('%')
	})
})

/**
 * The daily trend.
 *
 * These exist because of a real incident. Darden's GA4 fell 86% below Vercel overnight on
 * 2026-08-24 and stayed there for over a week while Vercel ran flat. Every number the panel showed
 * was correct; none of them could distinguish that cliff from a gap that had always been there,
 * and diagnosing it meant exporting both series by hand.
 */
describe('panels tolerate an older route response', () => {
	it('measurement health renders without the daily series', () => {
		const legacy = {
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
					vercelVisitors: ok(1580), vercelDailyUnavailable: false,
					revenue: ok(910), currency: 'USD', orderStatuses: {},
					capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable'),
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
			interpretation: 'Sources differ.',
		} as never

		expect(() => render(<DataHealthPanel data={legacy} />)).not.toThrow()
		expect(render(<DataHealthPanel data={legacy} />)).toContain('475')
	})

	it('journey renders without landing pages', () => {
		const legacy = {
			steps: [{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(100), conversionFromPrevious: null }],
			approximate: true, measurement: 'independent-totals' as const, approximationNote: 'Independent totals.',
		} as never

		expect(() => render(<JourneyPanel data={legacy} />)).not.toThrow()
	})

	it('acquisition renders without rows', () => {
		const legacy = {
			totalSessions: 0, designIndustryShare: null, unattributedShare: null,
			rowsWithheld: false, rowsTruncated: false,
		} as never

		expect(() => render(<AcquisitionPanel data={legacy} />)).not.toThrow()
	})
})

/**
 * Layout that survives the compat shim falling back to a plain div.
 *
 * `@liiift-studio/sanity-ui-compat` renders a plain element when it cannot resolve a UI kit
 * component for the Studio version in use. A `gap={3}` on that fallback is a design token being
 * handed to CSS, which means nothing — so the Caveat badge and its notice text rendered on top of
 * one another and the panel read "Caveasubscribe is counted about twice per signup".
 *
 * Layout-critical spacing is therefore expressed as real CSS, and these assert it stays that way.
 * A type checker cannot see this class of bug: `gap={3}` is perfectly well typed.
 */
describe('layout does not depend on design tokens resolving', () => {
	it('separates the caveat badge from its text with real CSS', () => {
		const html = render(<NoticeList notices={['subscribe is counted about twice per signup']} />)
		expect(html).toContain('display:flex')
		expect(html).toMatch(/gap:\s*12px/)
		// The badge must not shrink, or long text squeezes it to nothing and they overlap again.
		expect(html).toMatch(/flex:\s*0 0 auto/)
	})

	it('wraps rather than overflowing a narrow pane', () => {
		const html = render(<NoticeList notices={['a notice long enough to need wrapping on a narrow Studio pane']} />)
		expect(html).toContain('flex-wrap:wrap')
	})

	it('lays the context cards out by available width, not by viewport breakpoints', () => {
		const html = render(
			<DataHealthPanel
				data={{
					ga4Pageviews: ok(543), vercelPageviews: ok(2392), shortfallRatio: 0.773,
					ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
					vercelVisitors: ok(1580), vercelDailyUnavailable: false,
					revenue: ok(910), currency: 'USD', orderStatuses: {},
					capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable'),
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
					interpretation: 'Sources differ.', daily: [],
				}}
			/>,
		)
		// A Studio panel is a resizable pane, sometimes inside an iframe; its width is unrelated
		// to the viewport, so breakpoint columns answered the wrong question.
		expect(html).toContain('auto-fit')
	})
})


/**
 * Caveats collapse past two.
 *
 * Every site caveat is emitted on every panel, relevant or not, so the stack was routinely long —
 * seven identical amber cards above the data on a Darden year range. A band that long trains a
 * reader to skip it, including the one that mattered.
 */
describe('NoticeList collapsing', () => {
	it('shows two and hides the rest behind a count', () => {
		const html = render(<NoticeList notices={['one', 'two', 'three', 'four']} />)
		expect(html).toContain('one')
		expect(html).toContain('two')
		expect(html).not.toContain('>three<')
		expect(html).toContain('2 more caveats')
		expect(html).toContain('aria-expanded="false"')
	})

	it('shows both without a disclosure when there are only two', () => {
		const html = render(<NoticeList notices={['one', 'two']} />)
		expect(html).toContain('one')
		expect(html).toContain('two')
		expect(html).not.toContain('more caveat')
	})

	it('says "caveat" rather than "caveats" for a single hidden one', () => {
		expect(render(<NoticeList notices={['a', 'b', 'c']} />)).toContain('1 more caveat')
	})
})

/**
 * Diagnostics must not crash on an older route's response. This is the array that was missed when
 * the other panels were made skew-tolerant, and it took the whole tab down.
 */
describe('DiagnosticsPanel tolerates a missing checks array', () => {
	it('renders rather than throwing', () => {
		const legacy = { verdict: 'pass' } as never
		expect(() => render(<DiagnosticsPanel data={legacy} />)).not.toThrow()
	})

	it('says nothing was verified rather than implying everything passed', () => {
		const legacy = { verdict: 'pass', checks: [] } as never
		expect(render(<DiagnosticsPanel data={legacy} />)).toContain('No checks ran')
	})
})

describe('Delta', () => {
	it('renders nothing when there is no comparison', () => {
		// An absent delta must never draw as "no change" — that is a different and much more
		// reassuring claim than "we could not compare". Rendered directly rather than through the
		// helper, which asserts non-empty output; empty is the whole point here.
		expect(renderToStaticMarkup(<Delta current={100} previous={null} />)).toBe('')
		expect(renderToStaticMarkup(<Delta current={null} previous={100} />)).toBe('')
	})

	it('prints the baseline on screen rather than hiding it in a tooltip', () => {
		// At seven orders a quarter an 18% move might be one order, so "from 100" is the fact and
		// the percentage is the decoration. A title attribute is invisible on touch, in a
		// screenshot, and to anyone who does not hover.
		const html = render(<Delta current={120} previous={100} />)
		expect(html).toContain('+20%')
		expect(html).toContain('from 100')
		expect(html).not.toContain('title=')
	})

	it('does not make a good move quieter than a bad one', () => {
		// A foundry's best month used to visually recede: good was 70% opacity, bad was full weight
		// with a rule under it. Backwards for the question the figure answers.
		const up = render(<Delta current={120} previous={100} />)
		const down = render(<Delta current={80} previous={100} />)
		const opacity = (html: string) => html.match(/opacity:([0-9.]+)/)?.[1]
		expect(opacity(up)).toBe(opacity(down))
	})

	it('says "no change" only when the values genuinely match', () => {
		expect(render(<Delta current={100} previous={100} />)).toContain('no change')
	})

	it('says "new" rather than an infinite percentage when the baseline was zero', () => {
		const html = render(<Delta current={12} previous={0} />)
		expect(html).toContain('new')
		expect(html).not.toContain('Infinity')
		expect(html).not.toContain('NaN')
	})

	it('reports a percentage figure in points, not as a percentage of a percentage', () => {
		// A consent rate moving 40% to 44% rose by 4 points. Calling that "+10%" is a different
		// and confusing claim about a figure that is already a percentage.
		const html = render(<Delta current={44} previous={40} unit="percent" />)
		expect(html).toContain('4.0 pts')
		expect(html).not.toContain('10%')
	})

	it('carries direction in the arrow and the words, not colour alone', () => {
		const down = render(<Delta current={80} previous={100} />)
		expect(down).toContain('↓')
		expect(down).toContain('-20%')
	})
})

describe('SortableTable interaction', () => {
	const rows = [
		{ name: 'impactsport.ca', sessions: 68 },
		{ name: 'typewolf.com', sessions: 12 },
	]

	const columns = [
		{ key: 'name', label: 'Source', sortValue: (r: typeof rows[0]) => r.name, render: (r: typeof rows[0]) => <span>{r.name}</span> },
		{ key: 'sessions', label: 'Sessions', numeric: true, sortValue: (r: typeof rows[0]) => r.sessions, render: (r: typeof rows[0]) => <span>{r.sessions}</span> },
	]

	it('renders a filter box and an export control only when asked', () => {
		const bare = render(<SortableTable caption="c" columns={columns} rows={rows} rowKey={(r) => r.name} />)
		expect(bare).not.toContain('Copy as CSV')
		expect(bare).not.toContain('type="search"')

		const full = render(
			<SortableTable
				caption="c"
				columns={columns}
				rows={rows}
				rowKey={(r) => r.name}
				filterOn={(r) => r.name}
				exportName="sources"
			/>,
		)
		expect(full).toContain('Copy as CSV')
		expect(full).toContain('search')
	})

	it('offers a per-row exclude control when filtering is enabled', () => {
		// The fix for a contaminated table is to take the bad row out and see what the rest looks
		// like. Sorting alone could not do that.
		const html = render(
			<SortableTable caption="c" columns={columns} rows={rows} rowKey={(r) => r.name} filterOn={(r) => r.name} />,
		)
		expect(html).toContain('Exclude impactsport.ca')
	})

	it('shows the truncation note when the server said the list is incomplete', () => {
		const html = render(
			<SortableTable
				caption="c"
				columns={columns}
				rows={rows}
				rowKey={(r) => r.name}
				truncatedNote="This is the top of a longer list."
			/>,
		)
		expect(html).toContain('This is the top of a longer list.')
	})
})

describe('panels survive an older API route', () => {
	// The Studio bundle and the site's route deploy on separate rails. Darden's Studio ran 0.13.1
	// against a production route still resolving 0.6.x, so every field added since arrived as
	// undefined. Reading `.status` on one threw inside a sort comparator, which meant the panel
	// rendered nothing at all rather than rendering without a column.

	it('renders TypefaceInterestPanel when revenue, buyRate and currency are absent', () => {
		const html = render(
			<TypefaceInterestPanel
				data={{
					rowsWithheld: false,
					interpretationNote: 'Aggregate interest per family.',
					rows: [
						// Exactly what a 0.12 route returns: no revenue, no buyRate.
						{ typeface: 'Omnes', viewed: ok(3792), tested: ok(910), bought: ok(21), testRate: 0.24 },
					],
				} as never}
			/>,
		)
		expect(html).toContain('Omnes')
		expect(html).toContain('3,792')
		// And no NaN leaks into the two columns the route did not send.
		expect(html).not.toContain('NaN')
	})

	it('renders DataHealthPanel when the new Vercel and revenue fields are absent', () => {
		const html = render(
			<DataHealthPanel
				data={{
					ga4Pageviews: ok(543), vercelPageviews: ok(2392), shortfallRatio: 0.773,
					ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
					interpretation: 'Sources differ.', daily: [],
				} as never}
			/>,
		)
		expect(html).toContain('543')
		expect(html).not.toContain('NaN')
	})

	it('renders AcquisitionPanel without NaN when the share fields are absent', () => {
		// `!== null` let undefined through, and formatPercent(undefined) printed "NaN%" in the
		// largest type on the panel.
		const html = render(
			<AcquisitionPanel
				data={{
					rows: [],
					rowsWithheld: false,
				} as never}
			/>,
		)
		expect(html).not.toContain('NaN')
	})
})

describe('DiagnosticsPanel verdicts', () => {
	it('does not describe a healthy site as broken when checks merely skipped', () => {
		// The severity order was fixed server-side so an all-skipped run stops reading as a problem,
		// but the panel still fell through to "0 failing, 0 worth a look. Panels depending on these
		// will be wrong or incomplete" — alarming, and false. Checks skip routinely.
		const html = render(
			<DiagnosticsPanel
				data={{
					verdict: 'skipped',
					checks: [
						{ id: 'a', label: 'Purchases agree with orders', status: 'skipped', detail: 'No purchases in range' },
						{ id: 'b', label: 'Vercel reachable', status: 'skipped', detail: 'Not configured' },
					],
				} as never}
			/>,
		)
		expect(html).toContain('Nothing is failing')
		expect(html).not.toContain('will be wrong or incomplete')
	})
})

describe('capture model rendering', () => {
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		interpretation: 'Sources differ.', daily: [],
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
	}

	it('never renders an inferred figure as a measured one', () => {
		// The whole reason `estimated` is its own variant. Adding it to the union was not enough —
		// MetricFigure had no branch for it at first, so it fell through and rendered as a plain
		// number, which is exactly the claim the variant exists to prevent.
		const html = render(
			<DataHealthPanel
				data={{
					...base,
					capture: {
						estimates: [{ basis: 'orders', rate: 0.5, observed: 5, actual: 10, note: 'Same event both sides.' }],
						rate: 0.5, low: 0.4, high: 0.6, discrepancy: null,
					},
					estimatedSessions: { status: 'estimated', value: 714, low: 595, high: 892, basis: 'GA4 sees about half.' },
				} as never}
			/>,
		)
		expect(html).toContain('Estimated')
		expect(html).toContain('595')
		expect(html).toContain('892')
	})

	it('surfaces a disagreement between sources as a finding, not as context', () => {
		const html = render(
			<DataHealthPanel
				data={{
					...base,
					capture: {
						estimates: [
							{ basis: 'orders', rate: 0.9, observed: 9, actual: 10, note: 'Same event both sides.' },
							{ basis: 'pageviews', rate: 0.2, observed: 200, actual: 1000, note: 'A lower bound.' },
						],
						rate: 0.9, low: 0.2, high: 0.9,
						discrepancy: 'GA4 is capturing purchases far better than pageviews.',
					},
					estimatedSessions: unavailable('not_applicable'),
				} as never}
			/>,
		)
		expect(html).toContain('The sources disagree')
		expect(html).toContain('capturing purchases far better')
		// Both estimates shown side by side rather than averaged into one number.
		expect(html).toContain('Measured against orders')
		expect(html).toContain('Measured against Vercel')
		expect(html).toContain('caution')
	})

	it('renders nothing for the section when no overlap was measurable', () => {
		const html = render(
			<DataHealthPanel
				data={{ ...base, capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable') } as never}
			/>,
		)
		expect(html).not.toContain('How much GA4 is seeing')
	})
})

describe('CrossSourceTimeline', () => {
	const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: 0.25, low: 0.2, high: 0.3, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'Sources differ.', daily: [],
		crossSource: days.map((date, i) => ({
			// ga4Pageviews, not sessions — the shaded region differences these against vercelPageviews
			// and both sides must be the same unit.
			date, vercelPageviews: 300 + i * 10, ga4Pageviews: 70 + i * 3, ga4Sessions: 60 + i, orders: i, revenue: i * 120,
		})),
		timelineEvents: [{ date: '2026-09-03', label: 'September release', detail: '1,200 sent, 84 clicked' }],
	}

	it('draws one line per row rather than competing sources', () => {
		// Two peer lines made the reader reconcile before getting an answer, and GA4 is not a
		// competing estimate of pageviews — it is a lossy subset of them.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('Everything, on one time axis')
		expect(html).toContain('Pageviews')
		expect(html).toContain('Revenue')
		expect(html).toContain('Each row has its own scale')
	})

	it('says each row has its own scale, without arguing the case for it', () => {
		// Small multiples are still the right choice over a dual axis, but forty words defending
		// that to a reader who never proposed the alternative was a code comment that escaped into
		// the UI. What a reader needs is how to read the chart.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('Each row has its own scale')
		expect(html).not.toContain('would invent a correlation')
	})

	it('draws the blind spot as a quantity, always visible, not behind a hover', () => {
		// The 24 August collapse announced itself as this region widening. Putting it behind an
		// interaction would switch the alarm off — so the fill is always drawn, and only the
		// constituent LINES are revealed on demand.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('what your analytics did not see')
		expect(html).toContain('what your analytics did not see')
		// A filled region, not an outline.
		expect(html).toMatch(/<path d="M[^"]*" fill="currentColor"/)
	})

	it('offers a non-pointer route to the per-source detail', () => {
		// Hover is unavailable on touch and unreachable by keyboard, so detail that exists only
		// under a pointer exists only for some people.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('Show what each source saw')
		expect(html).toContain('aria-pressed="false"')
	})

	it('rules a campaign send through the chart', () => {
		// Three sources and a fourth as a marker — the only view that can answer whether the send
		// moved traffic and money.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('Vertical rules mark campaign sends')
	})

	it('renders nothing rather than an empty frame below three days', () => {
		// Against OverviewPanel, which is the panel that actually draws the timeline. This asserted
		// on DataHealthPanel, which never renders it under any input — so the assertion could not
		// fail and the >= 3 guard was untested.
		const html = render(<OverviewPanel data={{ ...base, crossSource: base.crossSource.slice(0, 2) } as never} />)
		expect(html).not.toContain('Everything, on one time axis')
	})

	it('renders the timeline once there are three days', () => {
		expect(render(<OverviewPanel data={base as never} />)).toContain('Everything, on one time axis')
	})
})

describe('ProportionChart', () => {
	it('scales bars against the sum, not the largest row', () => {
		// Against the max, the top row is full width whatever it is worth — which is the misreading
		// the funnel avoids by anchoring to its entry step.
		const html = render(
			<ProportionChart
				bars={[
					{ key: 'a', label: 'Desktop', sublabel: 'Perpetual', value: 750 },
					{ key: 'b', label: 'Web', sublabel: '1 year', value: 250 },
				]}
				format={(v) => `$${v}`}
				totalLabel="Total"
			/>,
		)
		expect(html).toContain('width:75%')
		expect(html).toContain('width:25%')
		expect(html).toContain('$1000')
	})

	it('shows the share and the absolute together', () => {
		// A share alone hides that the leading row might be two orders; an absolute alone hides
		// that it is most of the business.
		const html = render(
			<ProportionChart bars={[{ key: 'a', label: 'Desktop', value: 3 }]} format={(v) => `${v} orders`} totalLabel="Total" />,
		)
		expect(html).toContain('3 orders')
		expect(html).toContain('100%')
	})

	it('renders nothing when the rows sum to zero', () => {
		expect(renderToStaticMarkup(
			<ProportionChart bars={[{ key: 'a', label: 'x', value: 0 }]} format={String} totalLabel="Total" />,
		)).toBe('')
	})
})

describe('the chart says in words what it draws', () => {
	const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
	const data = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x', daily: [],
		crossSource: days.map((date, i) => ({
			date, vercelPageviews: 300 + i * 10, ga4Pageviews: 70 + i * 3, ga4Sessions: 60 + i, orders: i, revenue: i * 120,
		})),
		timelineEvents: [],
	}

	it('states how much was missed and when the gap was worst', () => {
		// The region was drawn to scale and described only in the abstract, so the two facts it
		// exists to convey were available solely by squinting at a pale fill.
		const html = render(<OverviewPanel data={data as never} />)
		expect(html).toMatch(/GA4 missed [\d,]+ pageviews over this period/)
		expect(html).toContain('the gap was widest on')
	})

	it('carries the shape of the data in the accessible name, not just its subject', () => {
		// role="img" prunes every descendant, so this label IS the chart for a blind reader. It
		// previously named only which rows existed — the title, not the content.
		const html = render(<OverviewPanel data={data as never} />)
		expect(html).toMatch(/aria-label="5 days from [^"]*peaking at[^"]*"/)
	})

	it('is focusable, so a day can be read without a mouse', () => {
		// The older chart this supersedes had arrow-key stepping; this one shipped without any.
		const html = render(<OverviewPanel data={data as never} />)
		expect(html).toContain('tabindex="0"')
	})
})

describe('panel structure', () => {
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(4820), currency: 'USD', orderStatuses: { verified: 12 },
		audience: ok(4210), audienceGrowth: ok(108),
		campaigns: [{ title: 'September release', subject: 's', sentAt: '2026-09-03T10:00:00Z', sent: 1200, opens: 400, clicks: 84, unsubscribed: 2 }],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'Sources differ.', daily: [],
		crossSource: [], timelineEvents: [],
	}

	it('puts money, orders and the list on the Overview, not behind a plumbing tab', () => {
		// These were all on a tab whose own blurb said it was about how much of reality each source
		// sees — four of the owner's five questions filed under the instrument, on tab four.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('Revenue')
		expect(html).toContain('US$4,820')
		expect(html).toContain('Mailing list')
		expect(html).toContain('Email campaigns')
	})

	it('leads with a one-line verdict rather than making the reader derive one', () => {
		// Every input was already computed; the conclusion was left to be assembled by hand across
		// four tabs by comparing arrows.
		const previous = { ...base, revenue: ok(3800), vercelPageviews: ok(2300) }
		// shortfallRatio 0 — GA4 is seeing everything, so the all-clear is earned.
		const html = render(<OverviewPanel data={{ ...base, shortfallRatio: 0 } as never} previous={previous as never} />)
		// The money clause carries its amounts rather than a bare percentage: "Revenue down 62%" in
		// the largest type on the page is one order not landing, at these volumes.
		expect(html).toMatch(/Revenue up to US\$4,820 from US\$3,800/)
		// The fixture moves traffic 2%, which is suppressed but no longer rendered as "flat" — the
		// card beside it draws an arrow at that size, and the two used to contradict each other.
		expect(html).toContain('Traffic little changed')
		// Not a verdict clause any more: that you sent an email is not a finding, and it occupied a
		// slot in the one line the reader is meant to act on. The campaigns table below still says
		// how many, and the timeline still marks when.
		expect(html).not.toContain('campaign sent')
		expect(html).toContain('Email campaigns')
		// No all-clear is claimed at all: this line only ever knew one coverage ratio, and "nothing
		// broken" spoke for the site, the checkout and four other tabs.
		expect(html).not.toContain('nothing broken')
		expect(html).toContain('Revenue up to')
		// A suppressed move now carries its number, so it cannot contradict the card beneath it.
		expect(html).toContain('little changed')
	})

	it('says the measurement disagrees rather than claiming nothing is broken', () => {
		// A healthy-looking week measured badly is not a healthy week, and that caveat used to live
		// two tabs from the figures it qualifies.
		const html = render(
			<OverviewPanel
				data={{ ...base, shortfallRatio: 0, capture: { ...base.capture, discrepancy: 'GA4 is capturing purchases far better than pageviews.' } } as never}
				previous={base as never}
			/>,
		)
		expect(html).toContain('measurement disagrees between sources')
		expect(html).not.toContain('nothing broken')
	})

	it('keeps the instrument on Data health, away from the business figures', () => {
		const html = render(<DataHealthPanel data={base as never} />)
		expect(html).toContain('Pageviews, source against source')
		expect(html).toContain('Order statuses in this range')
		// And the money is not repeated here.
		expect(html).not.toContain('US$4,820')
	})

	it('folds the configuration checks into Data health rather than a tab of their own', () => {
		const html = render(
			<DataHealthPanel
				data={base as never}
				diagnostics={{ verdict: 'pass', checks: [{ id: 'a', label: 'GA4 reachable', status: 'pass', detail: 'ok' }] } as never}
			/>,
		)
		expect(html).toContain('Configuration')
		expect(html).toContain('GA4 reachable')
	})
})

describe('brushing and details on demand', () => {
	const days = Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x', daily: [],
		crossSource: days.map((date, i) => ({
			date, vercelPageviews: 300 + i * 10, ga4Pageviews: 70 + i * 3, ga4Sessions: 60 + i, orders: i, revenue: i * 120,
		})),
		timelineEvents: [],
	}

	it('offers the chart figures as a table, collapsed', () => {
		// A chart is a picture of the data and not the data. Serves a screen reader, a keyboard
		// user, anyone who cannot resolve axis type, and the copy-to-spreadsheet workflow — and
		// costs a sighted reader one line because it is a details element.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('<details')
		expect(html).toContain('Show these figures as a table')
		expect(html).toContain('Seen by GA4')
	})

	it('advertises brushing only when something can receive it', () => {
		// Without a handler the drag would do nothing, and telling the reader to drag would be a lie.
		expect(render(<OverviewPanel data={base as never} />)).not.toContain('narrow every panel')
		expect(render(<OverviewPanel data={base as never} onBrush={() => {}} />))
			.toContain('narrow every panel')
	})

	it('names the keyboard route to the brush, not just the drag', () => {
		// This is the tool's one cross-filter, and the pane is often narrow — a mouse-only
		// cross-filter is a cross-filter most of the time.
		const html = render(<OverviewPanel data={base as never} onBrush={() => {}} />)
		expect(html).toContain('arrow keys')
		expect(html).toContain('Enter')
	})

	it('sets a col-resize cursor only when brushing is available', () => {
		expect(render(<OverviewPanel data={base as never} onBrush={() => {}} />)).toContain('cursor:col-resize')
		expect(render(<OverviewPanel data={base as never} />)).not.toContain('cursor:col-resize')
	})
})

describe('stale-while-revalidate holds the right answer', () => {
	const ready = (report: string) => ({
		status: 'ready' as const,
		envelope: { report, range: {}, sources: {}, notices: [], data: {} },
	})

	it('holds a previous answer across a RANGE change', () => {
		// The whole point: a reader must be able to change one variable without losing their sort,
		// their filter and their place.
		expect(holdsPreviousAnswer(ready('acquisition') as never, 'acquisition')).toBe(true)
	})

	it('does NOT hold it across a REPORT change', () => {
		// Switching tabs with nothing cached used to keep the old envelope and hand it to the new
		// panel. Journey rendered with Acquisition's payload — no crash, because every field is
		// guarded with `?? []`, so it silently drew an empty funnel. Wrong content is worse than a
		// spinner, and unlike a spinner it looks like an answer.
		expect(holdsPreviousAnswer(ready('acquisition') as never, 'journey')).toBe(false)
	})

	it('holds nothing when there is no previous answer', () => {
		expect(holdsPreviousAnswer({ status: 'loading' } as never, 'journey')).toBe(false)
		expect(holdsPreviousAnswer({ status: 'error', message: 'x' } as never, 'journey')).toBe(false)
	})
})

describe('the verdict can name the failure it exists for', () => {
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356),
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(4820), currency: 'USD', orderStatuses: {},
		audience: ok(4210), audienceGrowth: ok(108), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x', daily: [], crossSource: [], timelineEvents: [],
	}

	it('calls a large shortfall broken, even when the capture model cannot triangulate', () => {
		// The founding failure: an 86% shortfall running ten days. The verdict consulted only
		// capture.discrepancy, which is null below two estimates — and at 7 orders a quarter the
		// orders and email estimates are almost always under their minimum denominator on a Week.
		// So that outage read, on a Monday: "Revenue flat · Traffic flat · nothing broken".
		const html = render(<OverviewPanel data={{ ...base, shortfallRatio: 0.86 } as never} />)
		expect(html).toContain('treat its figures as broken')
		expect(html).not.toContain('nothing broken')
	})

	it('does not claim an all-clear when there is nothing to check', () => {
		// An older route sends no shortfallRatio. Silence is not evidence of health.
		const html = render(<OverviewPanel data={{ ...base, shortfallRatio: undefined } as never} />)
		expect(html).not.toContain('nothing broken')
	})

	it('renders list growth as a change, not as a delta against zero', () => {
		// audienceGrowth is already the net change; routing it through Delta printed "new from 0"
		// on an established list of four thousand people.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('+108 this period')
		expect(html).not.toContain('new from 0')
	})
})

describe('Overview survives an older API route', () => {
	// The default tab, and the one most dependent on `?? []` guards — and it had no skew case at
	// all, while the case that did exist asserted against a panel that no longer reads the field
	// it was written for.
	it('renders with none of the fields added since 0.6.x', () => {
		const legacy = {
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			interpretation: 'Sources differ.', daily: [],
		}
		expect(() => render(<OverviewPanel data={legacy as never} />)).not.toThrow()
		const html = render(<OverviewPanel data={legacy as never} />)
		// The figures the old route does send still render.
		expect(html).toContain('2,356')
		// The ones it does not degrade to a dash that says why, rather than to a zero or a NaN.
		// Its own reason, not `not_applicable` — which paired "Does not apply to this site" with
		// "redeploy the site to see it", two contradictory sentences about one dash.
		expect(html).toContain('older than this figure')
		expect(html).toContain('Not available from this site yet')
		expect(html).not.toContain('Does not apply to this site')
		expect(html).not.toContain('NaN')
		expect(html).not.toContain('undefined')
	})

	it('explains an empty pageview row rather than drawing a blank band', () => {
		// Vercel caps at 62 day-buckets, so Quarter and Year have no daily pageviews at all.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(1), vercelPageviews: ok(1), shortfallRatio: 0, ga4Sessions: ok(1), orders: ok(1),
			consentRate: unavailable('not_instrumented'), vercelVisitors: ok(1), vercelDailyUnavailable: true,
			revenue: ok(1), currency: 'USD', orderStatuses: {}, audience: ok(1), audienceGrowth: ok(0),
			campaigns: [], capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
			estimatedSessions: unavailable('not_applicable'), interpretation: 'x', daily: [],
			crossSource: ['2026-09-01', '2026-09-02', '2026-09-03'].map((date) => ({
				date, vercelPageviews: null, ga4Pageviews: 10, ga4Sessions: 8, orders: 0, revenue: 0,
			})),
			timelineEvents: [],
		} as never} />)
		expect(html).toContain('weekly buckets')
	})
})

describe('the chart draws at a 1:1 scale', () => {
	const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
	const data = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.2,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: ok(1), audienceGrowth: ok(0), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x', daily: [],
		crossSource: days.map((date, i) => ({
			date, vercelPageviews: 300 + i * 10, ga4Pageviews: 70 + i * 3, ga4Sessions: 60 + i, orders: i, revenue: i * 120,
		})),
		timelineEvents: [],
	}

	it('sets an explicit pixel height rather than deriving it from the aspect ratio', () => {
		// With height:auto the chart's physical height was paneWidth/760 — two rows came out 89px
		// tall in a narrow pane and 344px at full width, so row height was decided by how wide the
		// pane happened to be.
		const html = render(<OverviewPanel data={data as never} />)
		expect(html).toMatch(/style="width:100%;height:\d+(px)?;/)
		expect(html).not.toContain('height:auto')
	})

	it('server-renders at the documented default width, which the client then replaces', () => {
		// This is all static markup can prove. That the viewBox tracks the MEASURED width — the
		// actual claim — needs a DOM, and is covered by the dayIndexAt tests, which fail if the two
		// spaces disagree. Asserting viewBox height against CSS height would be a tautology: both
		// come from the same `height` variable.
		const html = render(<OverviewPanel data={data as never} />)
		expect(html).toMatch(/viewBox="0 0 760 \d+"/)
	})
})

describe('chrome sits on the side of the figures that matches what it does', () => {
	/**
	 * A RENDER test now, not a source-order one.
	 *
	 * This used to read the file and compare string offsets, and said so — its stated limit was that
	 * a wrapper could keep it green while the visual order regressed. That is close to what then
	 * happened: a wrapper (an unclosed <Text>) swallowed the panels, and the source test could not
	 * see it because the tokens were still in the right order. Rendering compares what is drawn.
	 */
	const data = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.8,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: ok(4000), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x', daily: [],
		crossSource: [], timelineEvents: [],
	}

	// Lazy. Rendering at describe scope means any throw happens during collection and takes the
	// entire file with it — which is how a bad fixture once hid 134 unrelated tests.
	const draw = () => renderToStaticMarkup(
		<ThemeProvider theme={theme}>
			<ReadyReport
				envelope={{
					report: 'measurement-health',
					range: { start: '2026-06-08', end: '2026-09-05', timezone: 'UTC' },
					sources: { ga4: { status: 'degraded', detail: 'not configured for this site' } },
					notices: ['A standing caveat about this site.'],
					data,
					comparison: { range: { start: '2026-03-10', end: '2026-06-07' }, data, provisional: false },
				} as never}
				tabId="overview"
				apiBaseUrl="https://x.test"
				range="quarter"
				custom={{ start: '2026-06-08', end: '2026-09-05' }}
				revalidationError="the network dropped"
				diagnostics={{ status: 'idle' } as never}
			/>
		</ThemeProvider>,
	)

	const at = (needle: string) => draw().indexOf(needle)
	const figures = () => at('Revenue')

	// The axis is whether the block changes how the figures below it are READ, not whether it is
	// about the instrument.
	for (const [chrome, why] of [
		['not configured for this site', 'explains why the panel below it is empty'],
		['the network dropped', 'says the figures are stale before they are read'],
		['Changes are against', 'is the legend for every delta beneath it'],
	] as const) {
		it(`puts "${chrome}" above the figures, because it ${why}`, () => {
			expect(at(chrome)).toBeGreaterThan(-1)
			expect(at(chrome)).toBeLessThan(figures())
		})
	}

	// These read the same most days, so at the top they were amber wallpaper above every figure.
	for (const chrome of ['A standing caveat about this site.', 'Figures cover']) {
		it(`puts "${chrome}" below the figures, because it does not change day to day`, () => {
			expect(at(chrome)).toBeGreaterThan(figures())
		})
	}
})

describe('discrete events are not drawn as a continuous line', () => {
	const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
	const data = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.2,
		ga4Sessions: ok(357), orders: ok(2), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(0), currency: 'USD', orderStatuses: {},
		audience: ok(1), audienceGrowth: ok(0), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x', daily: [],
		// Two orders in thirty days — the shape Darden actually has.
		crossSource: days.map((date, i) => ({
			date, vercelPageviews: 300, ga4Pageviews: 70, ga4Sessions: 60,
			orders: i === 4 || i === 19 ? 1 : 0, revenue: null,
		})),
		timelineEvents: [],
	}

	it('draws a stem on each day that had an order', () => {
		// A monotone curve through two points spread over a month drew a smooth rise and fall
		// across twenty-eight days on which nothing happened.
		const html = render(<OverviewPanel data={data as never} />)
		// fill="currentColor" is what makes it a data mark. The per-row clip rect lives in <defs>
		// and carries no fill, so it must not be counted.
		const rects = (html.match(/<rect[^>]*>/g) ?? []).filter((r) => r.includes('fill="currentColor"'))
		const stems = rects.filter((r) => !/height="3"/.test(r))
		expect(stems.length).toBe(2)
	})

	it('marks the days that were measured at zero, rather than leaving them blank', () => {
		// Drawing nothing for a zero made "no sales that day" identical to "Sanity reported nothing
		// for that day" — the distinction this package's figure primitives exist to keep.
		const html = render(<OverviewPanel data={data as never} />)
		// fill="currentColor" is what makes it a data mark. The per-row clip rect lives in <defs>
		// and carries no fill, so it must not be counted.
		const rects = (html.match(/<rect[^>]*>/g) ?? []).filter((r) => r.includes('fill="currentColor"'))
		expect(rects.filter((r) => /height="3"/.test(r)).length).toBe(28)
	})

	it('leaves a day with no measurement blank', () => {
		// Null, not zero. Nothing is drawn, because nothing is known.
		const gappy = {
			...data,
			crossSource: (data.crossSource as Array<Record<string, unknown>>).map((d, i) =>
				i < 10 ? { ...d, orders: null } : d,
			),
		}
		const html = render(<OverviewPanel data={gappy as never} />)
		// fill="currentColor" is what makes it a data mark. The per-row clip rect lives in <defs>
		// and carries no fill, so it must not be counted.
		const rects = (html.match(/<rect[^>]*>/g) ?? []).filter((r) => r.includes('fill="currentColor"'))
		// 30 days; days 0-9 unmeasured, which swallows the order on day 4. That leaves 20 measured
		// days carrying one order: 19 zero ticks and 1 stem.
		expect(rects.filter((r) => /height="3"/.test(r)).length).toBe(19)
		expect(rects.filter((r) => !/height="3"/.test(r)).length).toBe(1)
	})

	it('does not turn the traffic row into stems too', () => {
		// This guards OVER-application, not the change itself: reverting `mark: 'events'` would make
		// every row a line and leave this green. It is here because a continuous quantity drawn as
		// discrete events would be the mirror-image lie.
		const html = render(<OverviewPanel data={data as never} />)
		expect(html).toContain('stroke-width="2"')
	})
})

describe('the pointer lands on the day it is over', () => {
	/**
	 * `indexAt` needs a live getBoundingClientRect, which static markup does not have — which is
	 * precisely why this shipped broken. `dayIndexAt` is the same maths, extracted so it can be
	 * exercised without a DOM.
	 */
	const GUTTER = 52
	const RIGHT_PAD = 12
	const days = 90

	// Two panes and the SSR default. `plotWidth` is derived the way the component derives it.
	for (const boxWidth of [400, 760, 1400]) {
		const plotWidth = Math.max(120, boxWidth - GUTTER - RIGHT_PAD)

		it(`reaches the last day at the right edge of a ${boxWidth}px pane`, () => {
			// The bug: the conversion divided through a hard-coded 760 while the viewBox tracked the
			// measured width. At 400px the whole axis compressed into the left half; at 1400px the
			// last third of the range could not be pointed at.
			const last = dayIndexAt(boxWidth - RIGHT_PAD, 0, boxWidth, boxWidth, plotWidth, days)
			expect(last).toBe(days - 1)
		})

		it(`puts the midpoint of a ${boxWidth}px pane near the middle day`, () => {
			const mid = dayIndexAt(GUTTER + plotWidth / 2, 0, boxWidth, boxWidth, plotWidth, days)
			expect(mid).toBeGreaterThan(days / 2 - 2)
			expect(mid).toBeLessThan(days / 2 + 2)
		})
	}

	it('returns null rather than NaN before the chart has been measured', () => {
		// A collapsed or hidden pane reports zero width; dividing by it gave NaN, and NaN survived
		// the clamps to become a rendered crosshair at no position.
		expect(dayIndexAt(300, 0, 0, 760, 696, 90)).toBeNull()
		expect(dayIndexAt(300, 0, 760, 760, 0, 90)).toBeNull()
		expect(dayIndexAt(300, 0, 760, 760, 696, 0)).toBeNull()
	})

	it('clamps outside the plot to the first and last day', () => {
		expect(dayIndexAt(-500, 0, 760, 760, 696, 90)).toBe(0)
		expect(dayIndexAt(5000, 0, 760, 760, 696, 90)).toBe(89)
	})
})

describe('the coverage ribbon carries the shortfall to the tabs that cannot compute it', () => {
	beforeEach(() => { forgetShortfalls() })

	it('says nothing when the shortfall has never been measured', () => {
		// Silence is the honest answer. A panel that cannot say how lossy its source is must not
		// imply the source is fine.
		expect(knownShortfall('https://x.test', 'week')).toBeNull()
	})

	it('remembers a shortfall per site and per window', () => {
		// Per window, because carrying last week's coverage onto a quarter view is a different lie.
		rememberShortfall('https://x.test', 'week', undefined, { shortfallRatio: 0.8 })
		expect(knownShortfall('https://x.test', 'week')).toBe(0.8)
		expect(knownShortfall('https://x.test', 'quarter')).toBeNull()
		expect(knownShortfall('https://other.test', 'week')).toBeNull()
	})

	it('keys custom ranges by their bounds', () => {
		const a = { start: '2026-08-01', end: '2026-08-07' }
		const b = { start: '2026-07-01', end: '2026-07-07' }
		rememberShortfall('https://x.test', 'custom', a, { shortfallRatio: 0.5 })
		expect(knownShortfall('https://x.test', 'custom', a)).toBe(0.5)
		expect(knownShortfall('https://x.test', 'custom', b)).toBeNull()
	})

	it('refuses a ratio outside 0 to 1', () => {
		// Out of bounds means a bug upstream, not a coverage figure — and a ribbon reading "seeing
		// -40% of your traffic" would be worse than no ribbon.
		for (const bad of [-0.2, 1.4, Number.NaN, Number.POSITIVE_INFINITY]) {
			rememberShortfall('https://x.test', 'week', undefined, { shortfallRatio: bad })
			expect(knownShortfall('https://x.test', 'week'), String(bad)).toBeNull()
		}
	})
})

describe('the capture cards do not flatter the instrument', () => {
	it('shows a rate above 100% as what it is, and names the likely cause', () => {
		// It was clamped with Math.min(1, rate), so a tag firing twice rendered as a flat 100% under
		// the heading "How much GA4 is seeing" — the failure mode presented as perfection.
		const model = captureModel([fromOrders(18, 8)])
		expect(model.rate).toBeGreaterThan(2)
		const html = render(<DataHealthPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.2,
			ga4Sessions: ok(357), orders: ok(8), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1580), vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {},
			interpretation: 'x', daily: [], capture: model,
			estimatedSessions: unavailable('not_applicable'),
			audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
			campaigns: [], crossSource: [], timelineEvents: [],
		} as never} />)
		expect(html).toContain('225%')
		expect(html).toContain('usually a tag firing twice')
	})

	it('states how far one order moves the orders-based rate', () => {
		// "The denominator is exact" was on screen; "one order either way moves it fourteen points"
		// was in a comment. At these volumes the second is the one that decides how to read it.
		const estimate = fromOrders(2, 7)
		expect(estimate?.note).toContain('7 orders')
		expect(estimate?.note).toContain('14 points')
		expect(estimate?.note).not.toContain('exact')
		// The NUMERATOR is the fragile side. The note quoted the denominator's sensitivity — one more
		// order, worth about three points at a 20% capture — and printed the numerator's number
		// against it, so the one caveat given pointed at the steady half of the ratio.
		expect(estimate?.note).toContain('purchase seen by GA4')
	})
})

describe('a table says accurately what it is showing', () => {
	const rows = [
		{ name: 'google', sessions: 300 },
		{ name: 'direct', sessions: 200 },
		{ name: 'bot.example', sessions: 100 },
	]
	const columns = [
		{ key: 'name', label: 'Source', sortValue: (r: typeof rows[0]) => r.name, render: (r: typeof rows[0]) => <span>{r.name}</span> },
		{ key: 'sessions', label: 'Sessions', numeric: true, sortValue: (r: typeof rows[0]) => r.sessions, render: (r: typeof rows[0]) => <span>{r.sessions}</span> },
	]

	it('does not blame a filter for a dataset that is simply empty', () => {
		// It always said "No rows match this filter", so a site with no orders — or an unconfigured
		// GA4 — was told it had filtered its own data away, and went hunting for a control it had
		// never touched.
		const html = render(
			<SortableTable rows={[] as typeof rows} columns={columns as never} rowKey={(r: { name: string }) => r.name} caption="Sources" initialSort="sessions" />,
		)
		expect(html).toContain('Nothing to show for this period')
		expect(html).not.toContain('No rows match this filter')
	})

	it('counts filter-hidden rows separately from excluded ones', () => {
		// With nothing typed and nothing excluded, neither count applies — and the old arithmetic
		// double-counted, because `visible` filters on exclusion as well as on the query.
		const html = render(
			<SortableTable rows={rows} columns={columns as never} rowKey={(r: { name: string }) => r.name} caption="Sources" initialSort="sessions" />,
		)
		// Matching the status line's own phrasing — the word "excluded" also appears in each row's
		// exclude control, which is not what this is about.
		expect(html).not.toMatch(/\d+ rows? hidden/)
		expect(html).not.toMatch(/\d+ excluded/)
	})
})

describe('disagreement is a quantity, not only a shaded area', () => {
	it('gives the day-by-day table a sortable gap and coverage column', () => {
		// The table had Pageviews and Seen by GA4 as separate columns and nothing joining them, so
		// "which day did GA4 lose most" was answerable by eye and by nothing else.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.8,
			ga4Sessions: ok(357), orders: ok(2), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1580), vercelDailyUnavailable: false,
			revenue: ok(0), currency: 'USD', orderStatuses: {},
			audience: ok(1), audienceGrowth: ok(0), campaigns: [],
			capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
			estimatedSessions: unavailable('not_applicable'), interpretation: 'x', daily: [],
			crossSource: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].map((date, i) => ({
				date, vercelPageviews: 300, ga4Pageviews: i === 2 ? 20 : 250, ga4Sessions: 60, orders: 0, revenue: null,
			})),
			timelineEvents: [],
		} as never} />)
		expect(html).toContain('Missed by GA4')
		expect(html).toContain('GA4 coverage')
		// The collapsed day: 300 - 20 missed, at 7% coverage.
		expect(html).toContain('280')
		expect(html).toContain('7%')
	})

	it('reports a day either source did not measure as unknown, not as agreement', () => {
		// Zero would say the sources agreed; they did not, one of them was silent.
		expect(gapOf({ vercelPageviews: null, ga4Pageviews: 40 })).toBeNull()
		expect(gapOf({ vercelPageviews: 300, ga4Pageviews: null })).toBeNull()
		expect(coverageOf({ vercelPageviews: null, ga4Pageviews: 40 })).toBeNull()
	})

	it('keeps a negative gap rather than flooring it at zero', () => {
		// GA4 counting more than Vercel is a diagnosable state — a tag firing twice — and flooring
		// it would make that indistinguishable from perfect agreement.
		expect(gapOf({ vercelPageviews: 100, ga4Pageviews: 260 })).toBe(-160)
	})

	it('has no coverage figure for a day with no traffic', () => {
		// 0/0 rendered as 0% would sort the quietest days to the top of a ranking meant to find the
		// worst ones — the same unbounded-denominator trap as the worst-day sentence.
		expect(coverageOf({ vercelPageviews: 0, ga4Pageviews: 0 })).toBeNull()
	})
})

describe('a caught panel error clears on tab change without discarding state', () => {
	/**
	 * Exercised through the boundary's own static, which is where the logic lives. Rendering a
	 * thrown error and then changing a prop needs a DOM these tests do not have; the static is pure
	 * and is the thing the fix actually changed.
	 */
	const derive = (PanelBoundary as unknown as {
		getDerivedStateFromProps: (
			p: { resetKey: string },
			s: { error: Error | null; shownFor: string },
		) => { error: Error | null; shownFor: string } | null
	}).getDerivedStateFromProps

	it('clears the error when the tab changes', () => {
		const next = derive({ resetKey: 'journey' }, { error: new Error('boom'), shownFor: 'acquisition' })
		expect(next).toEqual({ error: null, shownFor: 'journey' })
	})

	it('leaves state alone when the tab has not changed', () => {
		// Returning a fresh object every render would clear an error the instant it was caught, and
		// the panel would loop between throwing and rendering.
		const error = new Error('boom')
		expect(derive({ resetKey: 'journey' }, { error, shownFor: 'journey' })).toBeNull()
		expect(derive({ resetKey: 'journey' }, { error: null, shownFor: 'journey' })).toBeNull()
	})
})

describe('the chart calls the same hooks whatever it is given', () => {
	/**
	 * A rules-of-hooks regression does not throw in static markup — it throws on the SECOND render,
	 * when React compares hook counts. So this asserts the source order instead: every hook must
	 * appear above the early return. It is a weaker check than a render, and it is the one that
	 * catches the bug that would white-screen the whole Studio pane.
	 */
	const source = readFileSync(new URL('./CrossSourceTimeline.tsx', import.meta.url), 'utf8')
	const body = source.slice(source.indexOf('export function CrossSourceTimeline('))
	const guard = body.indexOf('if (dates.length < 3')

	it('declares every hook before the early return', () => {
		expect(guard).toBeGreaterThan(-1)
		const after = body.slice(guard)
		for (const hook of ['useState(', 'useMemo(', 'useCallback(', 'useLayoutEffect(', 'useRef(']) {
			expect(after.includes(hook), `${hook} is called after the early return`).toBe(false)
		}
	})

	it('renders nothing, without throwing, below three days', () => {
		// The guard's own contract. Two days is not a span this chart can draw. Rendered directly
		// rather than through the `render` helper, which asserts non-empty output — right for a
		// panel, wrong for a component whose documented answer here is nothing at all.
		const html = renderToStaticMarkup(
			<CrossSourceTimeline
				series={[{
					key: 'a', label: 'A', source: 'Vercel', complete: true, unit: 'count',
					points: [{ date: '2026-09-01', value: 1 }, { date: '2026-09-02', value: 2 }],
				}]}
				currency={null}
			/>,
		)
		expect(html).toBe('')
	})
})

describe('every tab renders its own panel', () => {
	/**
	 * The test that was missing.
	 *
	 * Nothing in this suite mounted the report panel, because it only reaches its ready markup after
	 * a fetch resolves. In that blind spot, a reorder left the comparison sentence's <Text> unclosed
	 * — so every panel body became its child, and the three tabs outside COMPARED_TABS rendered
	 * nothing at all. It compiled, it type-checked, and 302 tests stayed green through two releases.
	 */
	const data = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.8,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: ok(4000), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x', daily: [],
		crossSource: [], timelineEvents: [],
		sources: [], totalSessions: ok(357), designIndustryShare: unavailable('not_applicable'),
		unattributedShare: unavailable('not_applicable'),
		steps: [], typefaces: [], licenceTiers: [], totalRevenue: ok(910),
	}

	const envelope = (report: string) => ({
		report, range: { start: '2026-06-08', end: '2026-09-05', timezone: 'UTC' },
		sources: {}, notices: [], data,
	})

	// Every tab, including the three that fail the comparison gate — which is the point.
	for (const [tabId, report, marker] of [
		['overview', 'measurement-health', 'Revenue'],
		['acquisition', 'acquisition', 'Sessions'],
		['journey', 'journey', 'per-step totals'],
		['typeface-interest', 'typeface-interest', 'Sort by any column'],
		['data-health', 'measurement-health', 'Vercel'],
	] as const) {
		it(`draws content on the ${tabId} tab`, () => {
			const html = render(
				<ReadyReport
					envelope={envelope(report) as never}
					tabId={tabId}
					apiBaseUrl="https://x.test"
					range="quarter"
					custom={{ start: '2026-06-08', end: '2026-09-05' }}
					revalidationError={null}
					diagnostics={{ status: 'idle' } as never}
				/>,
			)
			// More than the footer. The blank tabs still rendered "Figures cover …", so a length
			// check against that alone would have passed while three tabs were empty.
			expect(html).toContain(marker)
			expect(html.length).toBeGreaterThan(600)
		})
	}

	it('shows the comparison sentence only where a delta is drawn', () => {
		const withComparison = {
			...envelope('measurement-health'),
			comparison: { range: { start: '2026-03-10', end: '2026-06-07' }, data, provisional: false },
		}
		const props = {
			apiBaseUrl: 'https://x.test', range: 'quarter' as const,
			custom: { start: '2026-06-08', end: '2026-09-05' },
			revalidationError: null, diagnostics: { status: 'idle' } as never,
		}
		expect(render(<ReadyReport envelope={withComparison as never} tabId="overview" {...props} />))
			.toContain('Changes are against')
		// Journey draws no delta — but it must still draw its panel, which is exactly what the
		// nesting bug got wrong.
		const journey = render(<ReadyReport envelope={withComparison as never} tabId="journey" {...props} />)
		expect(journey).not.toContain('Changes are against')
		expect(journey).toContain('per-step totals')
	})
})

describe('a lossy denominator is presented as a ranking, not a rate', () => {
	const family = (viewed: number | null, bought: number | null) => ({
		viewed: viewed === null ? unavailable('not_instrumented') : ok(viewed),
		bought: bought === null ? unavailable('not_instrumented') : ok(bought),
		buyRate: viewed !== null && bought !== null && viewed > 0 ? bought / viewed : null,
	})

	it('pools every family rather than picking the middle one', () => {
		// 3 sales across 600 views.
		expect(catalogueRate([family(400, 1), family(200, 2)])).toBeCloseTo(3 / 600)
	})

	it('counts a family that was viewed and never sold', () => {
		// The row the column exists to surface. Excluding it from the benchmark — as filtering to
		// positive rates did — both removed the most informative row and biased the benchmark up.
		const withZero = catalogueRate([family(400, 0), family(200, 2)])
		expect(withZero).toBeCloseTo(2 / 600)
		expect(buyRateIndex(family(400, 0), withZero)).toBe(0)
	})

	it('has no benchmark when nothing sold or nothing was viewed', () => {
		expect(catalogueRate([family(400, 0), family(200, 0)])).toBeNull()
		expect(catalogueRate([])).toBeNull()
		expect(buyRateIndex(family(400, 1), null)).toBeNull()
	})

	it('ignores a family missing either side, rather than pooling half of it', () => {
		// Counting its sales without its views would inflate the catalogue rate.
		expect(catalogueRate([family(400, 1), family(null, 5)])).toBeCloseTo(1 / 400)
	})

	it('is unmoved when the tag breaks and every view count falls together', () => {
		// The whole reason for the change. When Darden's GA4 count fell from 471/day to 70, every
		// family's printed rate multiplied by about seven and the families that looked best were the
		// ones GA4 had stopped seeing. A comparison between families survives that; a rate does not.
		const healthy = [family(400, 1), family(200, 2), family(300, 0)]
		const collapsed = [family(60, 1), family(30, 2), family(45, 0)]
		const index = (rows: ReturnType<typeof family>[]) => {
			const benchmark = catalogueRate(rows)
			return rows.map((r) => buyRateIndex(r, benchmark))
		}
		const a = index(healthy)
		const b = index(collapsed)
		a.forEach((value, i) => expect(b[i]).toBeCloseTo(value as number, 6))
	})

	it('sorts a family with no comparable figure below one that has zero sales', () => {
		// Sorting on the raw rate returned 0 for a family whose cell reads "—", so ascending put a
		// block of dashes above the real answers.
		const benchmark = catalogueRate([family(400, 1), family(200, 2)])
		expect(buyRateIndex(family(400, 0), benchmark)).toBe(0)
		expect(buyRateIndex(family(null, null), benchmark)).toBeNull()
	})
})

describe('a lifetime figure is not shown as a period figure', () => {
	it('says the mailing-list card covers all time, beside three range-scoped cards', () => {
		// It sat in a row with Revenue, Orders and Traffic — all scoped to the range — as Mailchimp's
		// current all-time count, captioned only "not consent-gated or blockable", which reads as a
		// boast about accuracy rather than a statement of scope.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.2,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1580), vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {},
			audience: ok(4210), audienceGrowth: unavailable('not_applicable'), campaigns: [],
			capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
			estimatedSessions: unavailable('not_applicable'), interpretation: 'x', daily: [],
			crossSource: [], timelineEvents: [],
		} as never} />)
		expect(html).toContain('Mailing list, total')
		expect(html).toContain('not just this period')
	})
})

describe('the new revenue attribution survives an older API route', () => {
	// The live state between publishing this Studio and deploying the sites: the route returns no
	// purchases, no revenueShare, no trackedPurchases. The column must read as absent, never as zero
	// revenue, and the derivation note must not claim a split that was never computed.
	const legacy = {
		rows: [{
			source: 'fontsinuse.com', channel: 'Referral', medium: 'referral', campaign: null,
			sessions: 120, engagedSessions: 90, engagementRate: 0.75,
			designIndustry: true, unattributed: false,
		}],
		totalSessions: 357, designIndustryShare: 0.3, unattributedShare: 0.1,
		rowsWithheld: false, rowsTruncated: false,
	}

	it('renders the column as unavailable rather than as no revenue', () => {
		const html = render(<AcquisitionPanel data={legacy as never} />)
		expect(html).toContain('Revenue, split')
		// Not a zero, and not a currency symbol with nothing behind it.
		expect(html).not.toContain('of tracked sales')
	})

	it('does not print a derivation note for a split it never made', () => {
		const html = render(<AcquisitionPanel data={legacy as never} />)
		expect(html).not.toContain('purchases Google Analytics attributed')
	})

	it('still shows the sessions the older route did return', () => {
		expect(render(<AcquisitionPanel data={legacy as never} />)).toContain('120')
	})
})

describe('the revenue split divides by the whole, and says when the rows do not', () => {
	const base = {
		totalSessions: 357, designIndustryShare: null, unattributedShare: null,
		rowsWithheld: false, rowsTruncated: false, currency: 'USD',
		actualRevenue: 10000, actualOrders: 20,
	}
	const row = (source: string, sessions: number, purchases: number, share: number) => ({
		source, channel: 'Referral', medium: 'referral', campaign: null,
		sessions, engagedSessions: sessions, engagementRate: 1,
		designIndustry: false, unattributed: false,
		purchases, revenueShare: share, apportionedRevenue: 10000 * share,
	})

	it('says so when the visible rows account for only part of the split', () => {
		// The shares are against every attributed purchase, so when a selling source falls outside
		// the top rows by sessions the visible shares correctly do not sum to 100 — and a reader
		// adding up the column deserves to know why rather than assume the arithmetic is broken.
		const html = render(<AcquisitionPanel data={{
			...base, trackedPurchases: 20, shownPurchases: 12, splitIsSound: true,
			rows: [row('a.test', 300, 8, 0.4), row('b.test', 200, 4, 0.2)],
		} as never} />)
		expect(html).toContain('does not add up to the whole')
		expect(html).toContain('12 of those sales')
	})

	it('stays quiet when every attributed sale is on screen', () => {
		const html = render(<AcquisitionPanel data={{
			...base, trackedPurchases: 12, shownPurchases: 12, splitIsSound: true,
			rows: [row('a.test', 300, 8, 0.667), row('b.test', 200, 4, 0.333)],
		} as never} />)
		expect(html).not.toContain('does not add up to the whole')
	})
})

describe('the timeline runs on a calendar, not on the days sources happened to report', () => {
	it('fills every day between the bounds', () => {
		expect(calendarDays('2026-09-01', '2026-09-05')).toEqual([
			'2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
		])
	})

	it('crosses a month and a DST boundary without repeating or skipping a day', () => {
		// Stepped in UTC. In local time a DST shift puts two identical dates in the series or drops
		// one — on a chart whose whole subject is whether two sources agree about a given day.
		const days = calendarDays('2026-10-24', '2026-11-02')
		expect(new Set(days).size).toBe(days.length)
		expect(days.length).toBe(10)
		expect(days[7]).toBe('2026-10-31')
	})

	it('returns nothing for an inverted or malformed range', () => {
		expect(calendarDays('2026-09-05', '2026-09-01')).toEqual([])
		expect(calendarDays('not-a-date', '2026-09-01')).toEqual([])
	})

	it('is bounded, so a malformed range cannot spin', () => {
		expect(calendarDays('1990-01-01', '2026-01-01').length).toBeLessThanOrEqual(800)
	})
})

describe('money keeps one precision down a column', () => {
	it('does not switch precision at a thousand', () => {
		// "$850.00" and "$1,200" sat in adjacent rows, and an axis top read "$1,000" over a baseline
		// reading "$0.00" — the mismatch the chart's own comment claims to have fixed.
		expect(formatMoney(850, 'USD')).toBe(formatMoney(850, 'USD'))
		const small = formatMoney(850, 'USD')
		const large = formatMoney(1200, 'USD')
		const decimals = (s: string) => (s.split('.')[1] ?? '').replace(/\D+$/, '').length
		expect(decimals(small)).toBe(decimals(large))
	})

	it('uses the same separators as the counts beside it', () => {
		// Counts were hard-coded to en-GB while money took the viewer's locale, so one row could
		// carry two separator conventions.
		expect(formatMoney(1200, 'USD')).toContain('1,200')
		expect(formatCount(1200)).toBe('1,200')
	})
})

describe('a dated collapse reads differently from a standing shortfall', () => {
	const dates = (n: number) => Array.from({ length: n }, (_, i) => {
		const d = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000)
		return d.toISOString().slice(0, 10)
	})

	it('finds the day coverage fell and says it has not recovered', () => {
		// The founding case: Darden's GA4 ran at ~95% and fell to ~15% on one day, and the summary
		// could not tell that apart from "GA4 always sees a fifth", because a total and a worst day
		// are the same two numbers either way.
		const days = [...Array(40).fill(0.95), ...Array(12).fill(0.15)]
		const found = findCoverageIncident(days, dates(52))
		expect(found?.onset).toBe('2026-08-10')
		expect(found?.days).toBe(12)
		expect(found?.ongoing).toBe(true)
		expect(found?.before).toBeCloseTo(0.95, 2)
		expect(found?.during).toBeCloseTo(0.15, 2)
	})

	it('says nothing when the shortfall is simply constant', () => {
		// A site GA4 has always undercounted has no incident to report, and inventing one would send
		// the reader hunting for a change that never happened.
		expect(findCoverageIncident(Array(60).fill(0.2), dates(60))).toBeNull()
	})

	it('reports a recovered dip as recovered', () => {
		const days = [...Array(30).fill(0.9), ...Array(5).fill(0.1), ...Array(20).fill(0.9)]
		const found = findCoverageIncident(days, dates(55))
		expect(found?.ongoing).toBe(false)
		expect(found?.days).toBe(5)
	})

	it('ignores a dip too short to be a fault', () => {
		// Two days is a weekend, a deploy, a cache. Naming a date carries authority the evidence
		// does not have.
		const days = [...Array(30).fill(0.9), 0.1, 0.1, ...Array(20).fill(0.9)]
		expect(findCoverageIncident(days, dates(52))).toBeNull()
	})

	it('will not name a date from a short range', () => {
		expect(findCoverageIncident([...Array(7).fill(0.9), ...Array(5).fill(0.1)], dates(12))).toBeNull()
	})

	it('needs a before to call it a change, without abandoning later incidents', () => {
		// This was `expect(found?.onset).not.toBe(dates[0])`, which passes on a null return — so it
		// would have passed if the function did nothing at all. Worse, the rule aborted the whole
		// search rather than rejecting one candidate, so a range opening mid-outage reported nothing
		// including any later incident it did have.
		const opensLow = [...Array(20).fill(0.1), ...Array(30).fill(0.9)]
		expect(findCoverageIncident(opensLow, dates(50))).toBeNull()

		// Same opening, plus a real later collapse. The later one must still be found.
		const alsoLater = [...Array(12).fill(0.1), ...Array(30).fill(0.9), ...Array(14).fill(0.1)]
		const found = findCoverageIncident(alsoLater, dates(56))
		expect(found).not.toBeNull()
		expect(found?.onset).toBe(dates(56)[42])
	})

	it('still detects an outage covering more than half the window', () => {
		// A median tolerates contamination only to half the sample, so once the outage was the
		// majority the median WAS the outage and the function went silent — detection got quieter as
		// the fault got worse. A 46-day collapse in a 90-day quarter is the default range.
		const days = [...Array(44).fill(0.9), ...Array(46).fill(0.1)]
		const found = findCoverageIncident(days, dates(90))
		expect(found?.onset).toBe(dates(90)[44])
		expect(found?.days).toBe(46)
		expect(found?.ongoing).toBe(true)
	})

	it('does not let a quiet unmeasured day cut an outage in half', () => {
		// A day with no traffic yields a null, which used to end the run: a ten-day outage split
		// into 6 and 3, the longer half won, and the reported onset named a day inside the outage
		// rather than its start.
		const days = [...Array(30).fill(0.9), 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, null, 0.1, 0.1, 0.1]
		const found = findCoverageIncident(days, dates(40))
		expect(found?.onset).toBe(dates(40)[30])
		expect(found?.days).toBe(10)
	})

	it('will not say recovered on the strength of one day back', () => {
		// It meant only "the run did not touch the end of the array", so a single day above the
		// threshold — or a null final day — printed "then recovered" while coverage sat at half what
		// it had been. This is the tool's one dated alarm and it could stand itself down.
		const days = [...Array(30).fill(0.9), ...Array(15).fill(0.1), 0.5]
		expect(findCoverageIncident(days, dates(46))?.ongoing).toBe(true)
	})

	it('calls a partial recovery to a lower plateau ongoing', () => {
		const days = [...Array(30).fill(0.9), ...Array(10).fill(0.1), ...Array(15).fill(0.45)]
		expect(findCoverageIncident(days, dates(55))?.ongoing).toBe(true)
	})

	it('is not fooled into taking the incident as its own baseline', () => {
		// A mean would be dragged down by a long outage until the outage stopped looking unusual.
		// The median keeps the pre-collapse normal as the reference.
		const days = [...Array(25).fill(0.9), ...Array(25).fill(0.1)]
		const found = findCoverageIncident(days, dates(50))
		expect(found).not.toBeNull()
		expect(found?.before).toBeCloseTo(0.9, 2)
	})
})

describe('a delta does not point at a change it has rounded away', () => {
	it('calls a sub-tenth-of-a-point percent move flat', () => {
		// It printed "↑ +0.0 pts from 43.2%" — an arrow and a direction on a magnitude of zero.
		expect(render(<Delta current={43.24} previous={43.2} unit="percent" />)).toContain('no change')
	})

	it('calls a move that rounds to 0% flat', () => {
		// 2 on 1,000 rounds to "0%", and an arrow beside it contradicts the number it labels.
		expect(render(<Delta current={1002} previous={1000} />)).toContain('no change')
	})

	it('still reports a move that survives its own rounding', () => {
		const html = render(<Delta current={1200} previous={1000} />)
		expect(html).toContain('+20%')
		expect(html).not.toContain('no change')
	})

	it('still reports a percent move of a tenth of a point', () => {
		expect(render(<Delta current={43.4} previous={43.2} unit="percent" />)).toContain('+0.2 pts')
	})
})

describe('a view can be sent to someone', () => {
	it('round-trips a custom window', () => {
		const view = { tab: 'acquisition', range: 'custom', from: '2026-08-24', to: '2026-09-07' }
		expect(decodeView(`#${encodeView(view)}`)).toEqual(view)
	})

	it('leaves the URL clean for a view nobody set', () => {
		expect(encodeView({})).toBe('')
		expect(mergeIntoHash('', {})).toBe('')
	})

	it('does not carry a custom window on a named range', () => {
		// A stale window riding along in every link would reopen someone else's dates when they
		// clicked a link about the week.
		const encoded = encodeView({ tab: 'overview', range: 'week', from: '2026-08-24', to: '2026-09-07' })
		expect(encoded).not.toContain('from')
		expect(encoded).not.toContain('2026-08-24')
	})

	it('drops a custom range missing an end, rather than defaulting it', () => {
		// One end alone resolves against a default the sender never saw — a different window
		// wearing the same link.
		expect(decodeView('#insights=range:custom;from:2026-08-24')).toEqual({})
	})

	it('refuses anything that is not a date or an identifier', () => {
		// The hash is attacker-controllable in the sense that anyone can send a link, and these
		// values reach a report request.
		expect(decodeView('#insights=from:2026-08-24T00:00:00Z;to:../../etc')).toEqual({})
		expect(decodeView('#insights=tab:<script>')).toEqual({})
		expect(decodeView('#insights=range:' + 'x'.repeat(200))).toEqual({})
	})

	it('ignores a fragment belonging to another tool', () => {
		expect(decodeView('#other=tab:whatever')).toEqual({})
	})

	it('preserves another tool\'s fragment when writing its own', () => {
		// The hash is shared. Overwriting it wholesale would silently break whatever else is using it.
		const next = mergeIntoHash('#other=keep-me', { tab: 'journey', range: 'month' })
		expect(next).toContain('other=keep-me')
		expect(next).toContain('insights=tab:journey;range:month')
	})

	it('replaces its own fragment rather than appending a second one', () => {
		const once = mergeIntoHash('', { tab: 'overview', range: 'week' })
		const twice = mergeIntoHash(once, { tab: 'journey', range: 'month' })
		expect(twice.match(/insights=/g)?.length).toBe(1)
		expect(twice).toContain('tab:journey')
	})

	it('survives a truncated link by keeping what parsed', () => {
		expect(decodeView('#insights=tab:journey;range')).toEqual({ tab: 'journey' })
	})
})

describe('the headline agrees with the cards under it', () => {
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.1,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(1000), currency: 'USD', orderStatuses: {},
		audience: ok(4000), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x', daily: [],
		crossSource: [], timelineEvents: [],
	}

	it('does not call a move flat while the card beside it draws an arrow', () => {
		// Two definitions of flat, an order of magnitude apart, ten pixels apart on the panel: the
		// verdict suppressed under 5% and the card drew an arrow above 0.5%, so "Traffic flat" sat
		// directly above "↑ +4% from 2,266".
		const html = render(<OverviewPanel
			data={{ ...base, vercelPageviews: ok(2356) } as never}
			previous={{ ...base, vercelPageviews: ok(2266) } as never}
		/>)
		expect(html).toContain('little changed')
		expect(html).not.toContain('Traffic flat')
	})

	it('still says flat when the card says no change too', () => {
		const html = render(<OverviewPanel
			data={{ ...base, vercelPageviews: ok(2356) } as never}
			previous={{ ...base, vercelPageviews: ok(2355) } as never}
		/>)
		expect(html).toContain('Traffic flat')
	})
})

describe('the pageview estimate is described in the direction it actually errs', () => {
	it('calls it a ceiling on GA4 coverage, not a floor', () => {
		// The package said "a LOWER bound: Vercel also counts crawlers" for its whole life. Vercel
		// Web Analytics is the @vercel/analytics client script on a first-party path — it is blocked
		// too, and it does not run for crawlers at all. So real traffic exceeds Vercel, the true
		// denominator is larger, and GA4/Vercel flatters GA4 rather than maligning it.
		const note = fromPageviews(475, 2356)?.note ?? ''
		expect(note).toContain('ceiling')
		expect(note).not.toContain('lower bound')
		expect(note).not.toContain('crawlers')
	})
})

describe('a lone capture estimate carries its own uncertainty', () => {
	it('does not print a zero-width interval', () => {
		// low and high were the min and max ACROSS estimates, so with one estimate both equalled the
		// point and the panel rendered "2,499 to 2,499" under an Estimated badge. On a Week range
		// only the pageview estimate clears its denominator, so that was the ordinary case.
		const model = captureModel([fromPageviews(475, 2356)])
		expect(model.estimates.length).toBe(1)
		expect(model.low).toBeLessThan(model.rate as number)
		expect(model.high).toBeGreaterThan(model.rate as number)
	})

	it('is wider when measured on fewer events', () => {
		// The honest signal at these volumes: the same rate from a handful of events deserves a much
		// wider range than one from thousands.
		const thin = captureModel([fromOrders(1, 7)])
		const thick = captureModel([fromOrders(140, 1000)])
		const width = (m: typeof thin) => (m.high as number) - (m.low as number)
		expect(width(thin)).toBeGreaterThan(width(thick) * 5)
	})

	it('still uses the spread between estimates when there is more than one', () => {
		// Their disagreement carries more than any single one's sampling error.
		const model = captureModel([fromOrders(2, 7), fromPageviews(475, 2356)])
		expect(model.low).toBeCloseTo(Math.min(2 / 7, 475 / 2356), 6)
		expect(model.high).toBeCloseTo(Math.max(2 / 7, 475 / 2356), 6)
	})
})

describe('a long range still comes back day by day', () => {
	it('splits a quarter into windows the endpoint will serve by day', () => {
		// Past 62 days the granularity used to step up to weeks, and every vercelPageviews became
		// null — so the coverage row, the incident detector, the missed total and both disagreement
		// columns went blank on exactly the ranges a reader opens to find when a gap opened.
		const windows = dailyWindows('2026-06-08', '2026-09-05')
		expect(windows.length).toBe(2)
		expect(windows[0]?.start).toBe('2026-06-08')
		expect(windows[windows.length - 1]?.end).toBe('2026-09-05')
	})

	it('covers every day exactly once, with no gap and no overlap', () => {
		const windows = dailyWindows('2026-01-01', '2026-06-30')
		for (let i = 1; i < windows.length; i++) {
			const previousEnd = Date.parse(`${windows[i - 1]!.end}T00:00:00Z`)
			const thisStart = Date.parse(`${windows[i]!.start}T00:00:00Z`)
			expect(thisStart - previousEnd).toBe(86_400_000)
		}
	})

	it('keeps every window inside the endpoint cap', () => {
		for (const w of dailyWindows('2026-01-01', '2026-12-31')) {
			const days = Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1
			expect(days).toBeLessThanOrEqual(62)
		}
	})

	it('gives up rather than firing an unbounded number of requests', () => {
		// Beyond six windows the request count stops being worth the resolution, and the caller
		// falls back to one coarser call.
		expect(dailyWindows('2020-01-01', '2026-12-31')).toEqual([])
	})

	it('throws on an inverted or malformed range rather than answering emptily', () => {
		// Empty meant two different things — "too long, use one coarse call" and "these dates are
		// nonsense" — and the caller could not tell them apart, so a bad date fell through to
		// granularityFor, which computes Math.round(NaN) + 1 and silently answers 'month'.
		expect(() => dailyWindows('2026-09-05', '2026-06-08')).toThrow(RangeError)
		expect(() => dailyWindows('not-a-date', '2026-09-05')).toThrow(RangeError)
	})

	it('needs one window for a short range, which is the old behaviour', () => {
		expect(dailyWindows('2026-09-01', '2026-09-07').length).toBe(1)
	})
})

describe('a correction uses an estimate that measures the same kind of loss', () => {
	it('will not gross traffic up by a purchase-capture rate', () => {
		// Sessions were corrected by model.rate — the ORDERS estimate whenever it exists, i.e.
		// purchase-event capture. capture.ts argues at length that purchase capture and traffic
		// capture fail independently, then used one to correct the other: a broken checkout tag
		// became a multiplier on the visitor count.
		// A denominator big enough that the sampling interval does not itself refuse the correction —
		// at seven orders it reaches zero and grossUp declines to bound anything, which is separately
		// correct and would mask what this test is about.
		const ordersOnly = captureModel([fromOrders(40, 200)])
		expect(grossUp(357, ordersOnly, ['pageviews', 'email'])).toBeNull()
		// Unrestricted it happily corrects traffic by a purchase rate, which is what the caller must
		// not do for sessions.
		expect(grossUp(357, ordersOnly)).not.toBeNull()
	})

	it('uses the traffic estimate when one exists, ignoring the orders one', () => {
		const both = captureModel([fromOrders(40, 200), fromPageviews(475, 2356)])
		// The orders estimate is the most trusted overall and would be picked by default.
		expect(both.rate).toBeCloseTo(40 / 200, 6)
		const grossed = grossUp(475, both, ['pageviews', 'email'])
		// Corrected on the pageview rate instead: 475 / (475/2356).
		expect(grossed?.value).toBeCloseTo(2356, 0)
	})
})

describe('an order lands on the day it happened, where the reader lives', () => {
	it('buckets by the property timezone, not UTC', () => {
		// A US-Pacific foundry: 01:30 UTC on the 6th is 18:30 on the 5th locally. Every order placed
		// after 5pm was drawn on the following day, and the chart's whole cross-source question is
		// whether a campaign send moved revenue — a marker and a stem one day apart is the answer.
		expect(zonedDay('2026-09-06T01:30:00Z', 'America/Los_Angeles')).toBe('2026-09-05')
		expect(zonedDay('2026-09-06T01:30:00Z', 'UTC')).toBe('2026-09-06')
	})

	it('handles a zone ahead of UTC too', () => {
		expect(zonedDay('2026-09-05T22:30:00Z', 'Asia/Tokyo')).toBe('2026-09-06')
	})

	it('falls back rather than throwing on a zone the runtime does not know', () => {
		expect(zonedDay('2026-09-05T12:00:00Z', 'Not/AZone')).toBe('2026-09-05')
	})

	it('refuses to invent a day from input that has none', () => {
		// It returned iso.slice(0, 10), so a malformed timestamp became an eight-character key in the
		// by-date map and was drawn on the chart as a day. A bucket key must never be able to invent
		// one; the order still counts toward the totals, it just cannot be placed.
		expect(zonedDay('not-a-date', 'UTC')).toBeNull()
		expect(zonedDay(undefined, 'UTC')).toBeNull()
		expect(zonedDay(12345, 'UTC')).toBeNull()
	})

	it('agrees with the routine the range bounds are built from', () => {
		// They must match exactly for an order to land inside the window that selected it, and two
		// separate Intl calls — one format(), one reassembling formatToParts() — were relied on to
		// agree with nothing making them.
		for (const iso of ['2026-09-06T01:30:00Z', '2026-03-08T10:00:00Z', '2026-11-01T08:30:00Z']) {
			expect(zonedDay(iso, 'America/Los_Angeles'))
				.toBe(formatInTimeZone(new Date(iso), 'America/Los_Angeles'))
		}
	})
})

describe('a filtered correction does not smuggle the excluded estimate back in', () => {
	it('builds its interval from the admissible estimates only', () => {
		// The low/high fell through to the model's own, which are the min and max across EVERY
		// estimate — so a traffic figure got a lower bound derived entirely from the orders rate,
		// exactly the purchase-tag capture the filter exists to keep out.
		const model = captureModel([fromOrders(120, 200), fromPageviews(400, 2000)])
		const grossed = grossUp(400, model, ['pageviews', 'email'])
		expect(grossed).not.toBeNull()
		// 400 / 0.60 = 667 would be the orders rate leaking through as the bottom of the range.
		expect(grossed!.low).toBeGreaterThan(1500)
		// And the point must sit inside its own interval, not on its edge.
		expect(grossed!.value).toBeGreaterThan(grossed!.low)
		expect(grossed!.value).toBeLessThan(grossed!.high)
	})

	it('still corrects at the volumes this package actually sees', () => {
		// The sampling interval reaches zero whenever the rate is at or under about 4/(n+4), which at
		// a fifth capture and single-digit orders is the ordinary case — and grossUp discarded the
		// whole figure over it, while the caller reported "not enough overlap", which was false.
		const model = captureModel([fromOrders(1, 7)])
		const grossed = grossUp(357, model)
		expect(grossed).not.toBeNull()
		expect(grossed!.value).toBeCloseTo(357 * 7, 0)
		// The upper end is honestly enormous rather than absent.
		expect(grossed!.high).toBeGreaterThan(grossed!.value)
	})
})

describe('a capture rate above 100% keeps its point inside its own interval', () => {
	it('does not clamp the bounds to a range the rate sits outside', () => {
		// A rate above 1 is explicitly supported — it means GA4 counted more, not less — but the
		// bounds were clamped to 0..1, so a 140% capture rate came back as 91% to 100%: a point
		// estimate printed outside the interval drawn around it.
		const model = captureModel([fromOrders(14, 10)])
		expect(model.rate).toBeCloseTo(1.4, 6)
		expect(model.low as number).toBeLessThan(model.rate as number)
		expect(model.high as number).toBeGreaterThan(model.rate as number)
	})

	it('still floors the lower bound at zero', () => {
		// Below zero has no meaning for a capture rate, however wide the interval.
		const model = captureModel([fromOrders(1, 6)])
		expect(model.low as number).toBeGreaterThanOrEqual(0)
	})
})

describe('an estimate never prints a range its own point sits outside', () => {
	it('orders the bounds when the two clamps cross', () => {
		// low is clamped with Math.min(1, high) and high with a floor of 0.01, and they pass each
		// other whenever the capture rate is under about 1% — which is not exotic, it is a dead tag,
		// the failure this package exists for. The panel renders both verbatim, so it printed
		// "~10,000" over "1,502 to 500".
		const model = captureModel([fromPageviews(5, 10000)])
		const grossed = grossUp(5, model, ['pageviews', 'email'])
		expect(grossed).not.toBeNull()
		expect(grossed!.low).toBeLessThanOrEqual(grossed!.high)
	})

	it('names the estimate the figure was actually built from', () => {
		// The caption read the model's own rate and first basis, which after filtering is a different
		// estimate — so it said "seeing 14%, measured against the orders that exist" beside a number
		// derived from a 20% pageview rate. The label disagreed with its own arithmetic.
		const model = captureModel([fromOrders(1, 7), fromPageviews(2000, 10000)])
		const grossed = grossUp(1000, model, ['pageviews', 'email'])
		expect(grossed!.basis).toBe('pageviews')
		expect(grossed!.rate).toBeCloseTo(0.2, 6)
		expect(Math.round(1000 / grossed!.rate)).toBe(Math.round(grossed!.value))
	})
})

describe('a funnel rate needs a denominator that can carry one', () => {
	const stages = (values: number[]) => values.map((value, i) => ({
		key: `s${i}`,
		label: ['Landed', 'Viewed a typeface', 'Used the tester', 'Added to cart', 'Began checkout', 'Purchased'][i]!,
		value,
		conversionFromPrevious: i === 0 ? null : value / values[i - 1]!,
	}))

	it('prints a rate where the population supports it', () => {
		// Every rung clears the floor on both ends, so both rates print.
		const html = render(<FunnelChart stages={stages([2000, 900, 400, 200, 120, 60])} measurement="sequence" />)
		expect(html).toContain('of landed')
		expect(html).toContain('of began checkout')
	})

	it('withholds a step-to-step rate computed on single digits', () => {
		// The last figure in the tool still stating a small-sample number with full authority: at
		// seven orders a quarter "33.3% of began checkout" is one visitor out of three, drawn to a
		// decimal place beside rates computed on hundreds.
		const html = render(<FunnelChart stages={stages([400, 180, 60, 12, 3, 1])} measurement="sequence" />)
		expect(html).not.toContain('of began checkout')
	})

	it('still shows the counts, which are facts at any size', () => {
		// How many people reached a step does not need a population; the ratio does.
		const html = render(<FunnelChart stages={stages([400, 180, 60, 12, 3, 1])} measurement="sequence" />)
		expect(html).toContain('12')
		expect(html).toContain('3')
	})

	it('says why a rate is missing rather than leaving a gap', () => {
		const html = render(<FunnelChart stages={stages([8, 5, 3])} measurement="sequence" />)
		expect(html).toContain('too few to give a rate')
	})
})

describe('the chart anchors each row against the period before it', () => {
	const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
	const shell = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.2,
		ga4Sessions: ok(357), orders: ok(2), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(0), currency: 'USD', orderStatuses: {},
		audience: ok(1), audienceGrowth: ok(0), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x', daily: [],
		timelineEvents: [],
	}
	const series = (ga4: number) => days.map((date) => ({
		date, vercelPageviews: 300, ga4Pageviews: ga4, ga4Sessions: 60, orders: 0, revenue: null,
	}))

	it('draws a ghost line when a comparison window exists', () => {
		// Every row was an unanchored silhouette — a flat line at 60 and one at 6,000 are the same
		// picture. The comparison envelope was already fetched and spent only on the card deltas.
		const html = render(
			<OverviewPanel
				data={{ ...shell, crossSource: series(60) } as never}
				previous={{ ...shell, crossSource: series(285) } as never}
			/>,
		)
		expect(html).toContain('stroke-dasharray="2 3"')
	})

	it('draws no ghost when there is nothing to compare against', () => {
		const html = render(<OverviewPanel data={{ ...shell, crossSource: series(60) } as never} />)
		expect(html).not.toContain('stroke-dasharray="2 3"')
	})

	it('positions the ghost by day offset, not by its own dates', () => {
		// The previous window's dates are meaningless on this axis; point i belongs at day i of the
		// window being shown. Aligning by date would drop it off the chart entirely.
		const earlier = days.map((_, i) => ({
			date: `2026-08-0${i + 1}`, vercelPageviews: 300, ga4Pageviews: 285,
			ga4Sessions: 60, orders: 0, revenue: null,
		}))
		const html = render(
			<OverviewPanel
				data={{ ...shell, crossSource: series(60) } as never}
				previous={{ ...shell, crossSource: earlier } as never}
			/>,
		)
		expect(html).toContain('stroke-dasharray="2 3"')
	})
})

describe('the funnel gate looks at the rung, not just the funnel', () => {
	const stages = (values: number[]) => values.map((value, i) => ({
		key: `s${i}`,
		label: ['Landed', 'Viewed a typeface', 'Used the tester', 'Added to cart', 'Began checkout', 'Purchased'][i]!,
		value,
		conversionFromPrevious: i === 0 ? null : value / values[i - 1]!,
	}))

	it('withholds a share on a thin rung even when the funnel is large', () => {
		// The share was gated on `entry` — stage zero, and therefore the funnel's LARGEST number — so
		// it was withheld only when the whole funnel had under thirty entries, never when the rung
		// itself was a handful. "0.1% of landed" off four purchases read as a measurement.
		const html = render(<FunnelChart stages={stages([4000, 1800, 900, 300, 90, 4])} measurement="sequence" />)
		expect(html).toContain('too few to give a rate')
	})

	it('explains a withheld step-to-step rate rather than leaving a gap', () => {
		// The withheld half fell to an empty string, which is the unexplained gap the share half was
		// changed to avoid.
		const html = render(<FunnelChart stages={stages([4000, 1800, 900, 300, 20, 8])} measurement="sequence" />)
		expect(html).toContain('too few from')
	})
})

describe('a dated collapse is not invented out of quiet days', () => {
	const dates = (n: number) => Array.from({ length: n }, (_, i) =>
		new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10))

	it('ignores days too quiet to carry a ratio', () => {
		// At a couple of dozen pageviews a day, a quiet weekend with three pageviews and none seen is
		// coverage 0.0. Three of those in a row cleared the minimum run and printed a DATED
		// accusation about a day on which nothing happened — the loudest card in the tool, and
		// someone then pays to investigate that date.
		const busy = Array(40).fill(0.9)
		const coverage = [...busy, 0, 0, 0, ...Array(10).fill(0.9)]
		const volumes = [...Array(40).fill(300), 3, 2, 3, ...Array(10).fill(300)]
		expect(findCoverageIncident(coverage, dates(53), volumes)).toBeNull()
	})

	it('still finds a real collapse on days that do carry a ratio', () => {
		// The floor must not deafen the detector: a genuine fall on busy days is exactly what it is
		// for.
		const coverage = [...Array(40).fill(0.9), ...Array(12).fill(0.1)]
		const volumes = Array(52).fill(300)
		const found = findCoverageIncident(coverage, dates(52), volumes)
		expect(found?.onset).toBe(dates(52)[40])
		expect(found?.days).toBe(12)
	})

	it('is unchanged when no volumes are supplied', () => {
		// The parameter is optional so existing callers keep working; a caller that knows the volumes
		// gets the floor.
		const coverage = [...Array(40).fill(0.9), ...Array(12).fill(0.1)]
		expect(findCoverageIncident(coverage, dates(52))?.days).toBe(12)
	})
})

describe('the typeface table says which columns are already exact', () => {
	const data = {
		interpretationNote: 'x', rowsWithheld: false, licenceTiers: [], totalRevenue: ok(910),
		currency: 'USD',
		rows: [{
			typeface: 'Freight', viewed: ok(400), tested: ok(90), bought: ok(3),
			revenue: ok(910), testRate: 0.22, buyRate: 3 / 400,
		}],
	}

	it('names the source in every column header', () => {
		// The ribbon at the top of this tab instructs the reader to multiply its figures by about
		// five, and two of these four columns come from the order book. Following that instruction
		// across the whole table multiplies real revenue fivefold.
		const html = render(<TypefaceInterestPanel data={data as never} />)
		expect(html).toContain('Viewed (GA4)')
		expect(html).toContain('Tested (GA4)')
		expect(html).toContain('Bought (orders)')
		expect(html).toContain('Revenue (orders)')
	})

	it('says in words that the order columns must not be scaled up', () => {
		const html = render(<TypefaceInterestPanel data={data as never} />)
		expect(html).toContain('do not scale those up')
	})
})
