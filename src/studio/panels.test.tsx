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
import { captureModel, fromOrders } from '../core/capture'
import { forgetShortfalls, knownShortfall, rememberShortfall } from './useReport'
import { dayIndexAt } from './CrossSourceTimeline'
import React from 'react'
import {
	AcquisitionPanel,
	DiagnosticsPanel,
	JourneyPanel,
	OverviewPanel,
	DataHealthPanel,
	TypefaceInterestPanel,
} from './panels'
import { VisitorInsightsTool } from './VisitorInsightsTool'

// The tool mounts a panel, and the panel's hook calls useClient(), which needs a Studio source
// context these tests deliberately do not build. The contract under test is the props shape, so the
// client is stubbed with a token present — enough for the hook to get past its own guards and
// attempt a fetch, which never resolves here and does not need to.
vi.mock('sanity', () => ({
	useClient: () => ({ config: () => ({ token: 'test-token' }) }),
	definePlugin: (definition: unknown) => definition,
}))
import visitorInsights from '../index'
import { Delta, MetricFigure, NoticeList, ProportionChart, SortableTable, TrendChart } from './Figure'
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
describe('TrendChart', () => {
	const series = [
		{ date: '2026-08-20', ga4: 471, vercel: 494 },
		{ date: '2026-08-21', ga4: 422, vercel: 503 },
		{ date: '2026-08-22', ga4: 389, vercel: 387 },
		{ date: '2026-08-23', ga4: 390, vercel: 438 },
		{ date: '2026-08-24', ga4: 70, vercel: 490 },
	]

	it('draws a line for each source, one solid and one dashed', () => {
		const html = render(<TrendChart points={series} />)
		expect(html).toContain('<svg')
		// Counted by stroked paths specifically: the shaded gap band is a filled path and is not
		// a line, so a bare <path> count would silently pass whatever else got added.
		const stroked = (html.match(/<path[^>]*stroke="currentColor"/g) ?? []).length
		expect(stroked).toBe(2)
		expect(html).toContain('stroke-dasharray')
	})

	it('shades the band between the two lines, which is the gap itself', () => {
		const html = render(<TrendChart points={series} />)
		// A filled path with no stroke — the band, not a line.
		expect(html).toMatch(/<path[^>]*fill="currentColor"[^>]*stroke="none"/)
	})

	it('does not shade across a day where one source is missing', () => {
		const gapped = [
			{ date: '2026-08-20', ga4: 471, vercel: 494 },
			{ date: '2026-08-21', ga4: null, vercel: 503 },
			{ date: '2026-08-22', ga4: 389, vercel: 387 },
			{ date: '2026-08-23', ga4: 390, vercel: 438 },
		]
		const html = render(<TrendChart points={gapped} />)
		// One band only, over 22nd-23rd. Shading through the 21st would invent a gap from an absence.
		expect((html.match(/<path[^>]*stroke="none"/g) ?? []).length).toBe(1)
	})

	it('labels both axes, with real dates on the x axis', () => {
		const html = render(<TrendChart points={series} />)
		expect(html).toContain('20 Aug')
		expect(html).toContain('24 Aug')
		// Y axis carries a zero baseline and a top figure.
		expect(html).toContain('>0<')
	})

	it('rounds the y axis up to a readable maximum', () => {
		const html = render(<TrendChart points={[
			{ date: '2026-08-20', ga4: 471, vercel: 494 },
			{ date: '2026-08-21', ga4: 422, vercel: 503 },
			{ date: '2026-08-22', ga4: 389, vercel: 387 },
		]} />)
		// 503 rounds up to 1,000 rather than topping the axis at an arbitrary 503.
		expect(html).toContain('1,000')
	})

	it('breaks the line where a day has no figure, rather than drawing through zero', () => {
		const gapped = [
			{ date: '2026-08-20', ga4: 471, vercel: 494 },
			{ date: '2026-08-21', ga4: null, vercel: 503 },
			{ date: '2026-08-22', ga4: 389, vercel: 387 },
		]
		const html = render(<TrendChart points={gapped} />)
		// A break restarts the path with a second moveto. One M means the gap was drawn through.
		const ga4Path = (html.match(/d="([^"]*)"/g) ?? [])[1] ?? ''
		expect((ga4Path.match(/M/g) ?? []).length).toBe(2)
	})

	it('renders nothing when there are too few points to show a shape', () => {
		// Rendered without the `render` helper, which asserts non-empty output — the whole point
		// here is that the component declines to draw rather than showing a two-point "trend".
		const html = renderToStaticMarkup(
			<ThemeProvider theme={theme}><TrendChart points={series.slice(0, 2)} /></ThemeProvider>,
		)
		expect(html).not.toContain('<svg')
	})

	it('describes itself for screen readers', () => {
		expect(render(<TrendChart points={series} />)).toContain('2026-08-20 to 2026-08-24')
	})
})

/**
 * Version skew between the Studio and the API route.
 *
 * These are separate deployments on separate schedules. A Studio upgraded ahead of its route
 * receives a response missing whatever the newer version added, and on 2026-09-01 that took the
 * whole tool down: a Studio on 0.8.0 read `data.daily.length` from a route still on 0.6.2 and threw
 * "Cannot read properties of undefined". A panel must show less, never crash.
 *
 * Each case below renders a payload shaped like an older route's, cast because the current types
 * describe the newer shape — which is exactly the situation at runtime.
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
 * The chart is reachable without a mouse.
 *
 * A hover-only readout gives keyboard and touch users a picture they cannot interrogate — the same
 * failure as the tooltip-only explanations on unavailable metrics.
 */
describe('TrendChart keyboard access', () => {
	const series = [
		{ date: '2026-08-20', ga4: 471, vercel: 494 },
		{ date: '2026-08-21', ga4: 422, vercel: 503 },
		{ date: '2026-08-22', ga4: 389, vercel: 387 },
	]

	it('is focusable', () => {
		expect(render(<TrendChart points={series} />)).toContain('tabindex="0"')
	})

	it('tells the reader both ways in are available', () => {
		expect(render(<TrendChart points={series} />)).toContain('arrow keys')
	})

	it('summarises itself for a screen reader without needing hover', () => {
		const html = render(<TrendChart points={series} />)
		expect(html).toContain('2026-08-20 to 2026-08-22')
		expect(html).toContain('Peak')
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
		expect(html).toMatch(/Revenue up \d+%/)
		expect(html).toContain('Traffic flat')
		expect(html).toContain('1 campaign sent')
		// No all-clear is claimed at all: this line only ever knew one coverage ratio, and "nothing
		// broken" spoke for the site, the checkout and four other tabs.
		expect(html).not.toContain('nothing broken')
		expect(html).toContain('Revenue up')
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
		expect(html).toContain('predates this figure')
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
	 * A SOURCE test, deliberately.
	 *
	 * `ReportPanel` only reaches its ready branch after a fetch resolves, and these tests render to
	 * static markup, where effects never run — so there is no rendered output to assert against
	 * without building a fetch harness for one ordering question. Reading the source is the honest
	 * way to check it, as long as it says so. Its limit is real: a wrapper with CSS `order` or a
	 * portal would keep this green while the visual order regressed.
	 */
	const source = readFileSync(new URL('./VisitorInsightsTool.tsx', import.meta.url), 'utf8')
	const ready = source.slice(source.indexOf("{state.status === 'ready' && ("))
	const panel = ready.indexOf("tabId === 'overview'")

	it('finds the panel body', () => {
		expect(panel).toBeGreaterThan(-1)
	})

	// The axis is whether the block changes how the figures below it are READ, not whether it is
	// about the instrument. The source row renders only when a source failed, so when it renders at
	// all it explains an empty panel; the revalidation card says the figures are stale; and the
	// comparison sentence defines every delta beneath it.
	for (const [chrome, why] of [
		['<SourceStatusRow', 'explains why the panel below it is empty'],
		['state.revalidationError && (', 'says the figures are stale before they are read'],
		// The JSX, not the comment above it — matching on prose let this assert the wrong token.
		['{state.envelope.comparison.range.start}', 'is the legend for every delta beneath it'],
	] as const) {
		it(`puts ${chrome} above the figures, because it ${why}`, () => {
			expect(ready.indexOf(chrome)).toBeGreaterThan(-1)
			expect(ready.indexOf(chrome)).toBeLessThan(panel)
		})
	}

	// These read the same most days, so at the top they were amber wallpaper above every figure.
	for (const chrome of ['<NoticeList', 'Figures cover']) {
		it(`puts ${chrome} below the figures, because it does not change day to day`, () => {
			expect(ready.indexOf(chrome)).toBeGreaterThan(panel)
		})
	}

	it('renders each block exactly once, so a move cannot become a duplicate', () => {
		// The weakest link in a source test: substring presence would also be satisfied by a block
		// left behind under `{false && …}`. Counting at least rules out the copy-paste failure.
		for (const chrome of ['<SourceStatusRow', '<NoticeList', 'state.revalidationError && (']) {
			expect(ready.split(chrome).length - 1, chrome).toBe(1)
		}
	})
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
		const rects = html.match(/<rect[^>]*>/g) ?? []
		const stems = rects.filter((r) => !/height="1"/.test(r))
		expect(stems.length).toBe(2)
	})

	it('marks the days that were measured at zero, rather than leaving them blank', () => {
		// Drawing nothing for a zero made "no sales that day" identical to "Sanity reported nothing
		// for that day" — the distinction this package's figure primitives exist to keep.
		const html = render(<OverviewPanel data={data as never} />)
		const rects = html.match(/<rect[^>]*>/g) ?? []
		expect(rects.filter((r) => /height="1"/.test(r)).length).toBe(28)
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
		const rects = html.match(/<rect[^>]*>/g) ?? []
		// 30 days; days 0-9 unmeasured, which swallows the order on day 4. That leaves 20 measured
		// days carrying one order: 19 zero ticks and 1 stem.
		expect(rects.filter((r) => /height="1"/.test(r)).length).toBe(19)
		expect(rects.filter((r) => !/height="1"/.test(r)).length).toBe(1)
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
			<SortableTable rows={[]} columns={columns as never} rowKey={(r: never) => String(r)} caption="Sources" initialSort="sessions" />,
		)
		expect(html).toContain('Nothing to show for this period')
		expect(html).not.toContain('No rows match this filter')
	})

	it('counts filter-hidden rows separately from excluded ones', () => {
		// With nothing typed and nothing excluded, neither count applies — and the old arithmetic
		// double-counted, because `visible` filters on exclusion as well as on the query.
		const html = render(
			<SortableTable rows={rows} columns={columns as never} rowKey={(r: never) => (r as { name: string }).name} caption="Sources" initialSort="sessions" />,
		)
		// Matching the status line's own phrasing — the word "excluded" also appears in each row's
		// exclude control, which is not what this is about.
		expect(html).not.toMatch(/\d+ rows? hidden/)
		expect(html).not.toMatch(/\d+ excluded/)
	})
})
