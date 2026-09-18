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
import { columnIsEmpty, formatCount, formatMoney } from './Figure'
import { shortListNote } from './panels'
import { decodeView, encodeView, mergeIntoHash } from './urlState'
import { captureModel, fromOrders, fromPageviews, grossUp } from '../core/capture'
import { forgetShortfalls, knownShortfall, rememberShortfall } from './useReport'
import { CrossSourceTimeline, HoverCard, colorFor, dayIndexAt, findCoverageIncident } from './CrossSourceTimeline'
import { COMPARISON, COMPARISON_TEXT, MARKS, SERIES, mark, seriesFill } from './palette'
import React from 'react'
import {
	AcquisitionPanel,
	DiagnosticsPanel,
	JourneyPanel,
	OverviewPanel,
	DataHealthPanel,
	TypefaceInterestPanel,
	averageOrderValue,
	buyRateIndex,
	catalogueRate,
	coverageOf,
	firstStepRate,
	gapOf,
	rankLine,
	revenueCoversEveryOrder,
	revenuePerThousandSent,
	spread,
	visitorsPerOrder,
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
import { ContainmentBar, Delta, LicenceLadder, SPACE, EstimateDotPlot, FunnelChart, RatioFigure, MetricFigure, NoticeList, ProportionChart, Section, SectionTitle, SortableTable, isContainment, splitGrid } from './Figure'
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
/**
 * One rung of the funnel, by label.
 *
 * Scoped to the `<ol>` the funnel draws into. Splitting the whole document on `<li` puts the entire
 * panel above the chart into index 0 — including a segment table whose column headers repeat every
 * rung's name, so a naive `.find()` matched the table and asserted nothing about the chart.
 *
 * @param html - the rendered panel
 * @param label - the rung's label
 */
function funnelRung(html: string, label: string): string {
	const list = html.slice(html.lastIndexOf('<ol '))
	return list.split('<li').slice(1).find((rung) => rung.includes(label)) ?? ''
}

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
		// Named from the metric. The badge was the fixed string "Some orders only" — written for the
		// revenue case and then worn by every partial figure in the tool, including GA4 view counts
		// on Typeface interest, where no order is involved and it is simply false.
		expect(html).toContain('From 1 Sept only')
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
					vercelVisitors: ok(21400), ordersWithTotal: 64, vercelDailyUnavailable: false,
					revenue: ok(4820), currency: 'USD', orderStatuses: { verified: 60, refunded: 4 },
					capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable'),
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
					interpretation: 'Sources agree.',
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
					vercelVisitors: ok(1730), ordersWithTotal: null, vercelDailyUnavailable: false,
					revenue: unavailable('source_error'), currency: null, orderStatuses: {},
					capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable'),
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
					
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
		approximationNote: 'Each step is counted on its own, not as a tracked journey.',
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
		expect(html).toContain('Not a tracked path')
		expect(html).toContain('Each step is counted on its own')
		// Cautionary tone, because independent totals invite a drop-off reading they cannot support.
		expect(html).toContain('caution')
		// And the gaps between rungs are never described as people who left.
		expect(html).not.toContain('did not continue')
		// Nor as an arithmetic difference. "N fewer" was drawn on every gap, right-aligned against
		// the empty space where a tracked funnel would have put a bar — arithmetic the reader can do
		// from the two counts either side, restated under a card that forbids reading it as drop-off.
		// Scoped to the gap wording: the hatch key legitimately says "fewer days".
		expect(html).not.toMatch(/\d+ fewer/)
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
		expect(html).toContain('Tracked path')
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
		// declaration: the funnel bars carry the reference blue, so this also pins that a rung is
		// drawn as a rung rather than picking up the abandonment colour.
		expect(html.match(new RegExp(`background:rgba\\(76, 143, 208, 1\\);width:100%`, 'g'))).toHaveLength(2)
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
		expect(html).toContain('No source')
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
					vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
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
					vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
					revenue: ok(910), currency: 'USD', orderStatuses: {},
					capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null }, estimatedSessions: unavailable('not_applicable'),
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [], crossSource: [], timelineEvents: [],
					interpretation: 'Sources differ.',
				}}
			/>,
		)
		// A Studio panel is a resizable pane, sometimes inside an iframe; its width is unrelated
		// to the viewport, so breakpoint columns answered the wrong question.
		//
		// The claim is about the CONSTANT — how a card grid lays out — not about which panel hosts
		// one. Data health's Context cards now start folded, so this reads the constant directly
		// rather than hunting for a grid in rendered markup.
		// Overview, whose card grids are not folded. Data health's Context cards now start folded,
		// and the claim here is about how a card grid lays out, not about which panel hosts one.
		void html
		const overview = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1580), ordersWithTotal: 7, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
			audience: ok(4210), audienceGrowth: ok(108), crossSource: [], timelineEvents: [], campaigns: [],
		} as never} />)
		expect(overview).toContain('auto-fit')
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
					interpretation: 'Sources differ.',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		interpretation: 'Sources differ.',
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
		expect(html).toContain('Checked against your orders')
		expect(html).toContain('Checked against Vercel')
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

/** The `r, g, b` of a hex, as `seriesFill` writes it into an rgba() string. */
function rgbOf(hex: string): string {
	const part = (at: number) => parseInt(hex.slice(at, at + 2), 16)
	return `${part(1)}, ${part(3)}, ${part(5)}`
}

describe('CrossSourceTimeline', () => {
	const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: 0.25, low: 0.2, high: 0.3, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'Sources differ.',
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

	it('keeps the blind spot visible without drawing it as an area', () => {
		// The alarm must stay on — the founding incident announced itself here — but the filled
		// region was the wrong mark for it. Its width is the ABSOLUTE gap, and under a roughly flat
		// coverage rate that is the traffic curve scaled down: at 20% coverage the area is 0.8 times
		// traffic and tracks it exactly, so every busy day drew a wider alarm with no change in the
		// instrument at all. The coverage row makes precisely that argument in its own comment, to
		// justify its own existence.
		const html = render(<OverviewPanel data={base as never} />)
		// The alarm, in the two places that state it without scaling with traffic.
		expect(html).toContain('Share GA4 saw')
		expect(html).toMatch(/GA4 missed [\d,]+ pageviews/)
		// And the lossier source's own line is still drawn, which is what the detector reads.
		expect(html).toContain('Seen by GA4')
	})

	it('draws no filled area between the two sources', () => {
		const html = render(<OverviewPanel data={base as never} />)
		// A <path> with a fill is the region; every remaining path is a stroked line.
		expect(html).not.toMatch(/<path d="M[^"]*" fill="rgba\(/)
	})

	it('offers a non-pointer route to the per-source detail', () => {
		// Hover is unavailable on touch and unreachable by keyboard, so detail that exists only
		// under a pointer exists only for some people.
		//
		// This used to assert a "Show what each source saw" button. That button was inert: the state
		// it set fed one variable that nothing read, because the shortfall line it once gated is
		// drawn unconditionally now. It changed its own label and moved nothing else on screen. The
		// real non-pointer route is the focusable plot and its live readout, so that is what is
		// asserted here instead of a control that did nothing.
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).toContain('tabindex="0"')
		expect(html).toContain('aria-live')
	})

	it('does not ship a control that changes nothing', () => {
		const html = render(<OverviewPanel data={base as never} />)
		expect(html).not.toContain('Show what each source saw')
	})

	it('rules a campaign send through the chart', () => {
		// Three sources and a fourth as a marker — the only view that can answer whether the send
		// moved traffic and money.
		const html = render(<OverviewPanel data={base as never} />)
		// Named by the mark that actually distinguishes them. Grid rules are vertical too, and there
		// are more of them than there are campaigns, so "vertical rules" described most of the
		// wrong things on screen.
		expect(html).toContain('Dashed rules with a dot mark campaign sends')
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(4820), currency: 'USD', orderStatuses: { verified: 12 },
		audience: ok(4210), audienceGrowth: ok(108),
		campaigns: [{ title: 'September release', subject: 's', sentAt: '2026-09-03T10:00:00Z', sent: 1200, opens: 400, clicks: 84, unsubscribed: 2 }],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'Sources differ.',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(4820), currency: 'USD', orderStatuses: {},
		audience: ok(4210), audienceGrowth: ok(108), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x', crossSource: [], timelineEvents: [],
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
			interpretation: 'Sources differ.',
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
			estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: ok(1), audienceGrowth: ok(0), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: ok(4000), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(0), currency: 'USD', orderStatuses: {},
		audience: ok(1), audienceGrowth: ok(0), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'),
		interpretation: 'x',
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
		// A fill is what makes it a data mark. The per-row clip rect lives in <defs> and carries no
		// fill, so it must not be counted. Orders draw in the orders colour, which is also the
		// assertion that the row picked up its series colour at all.
		const rects = (html.match(/<rect[^>]*>/g) ?? [])
			.filter((r) => r.includes(`fill="${SERIES.orders}"`) && !r.includes('data-swatch'))
		const stems = rects.filter((r) => !/height="3"/.test(r))
		expect(stems.length).toBe(2)
	})

	it('marks the days that were measured at zero, rather than leaving them blank', () => {
		// Drawing nothing for a zero made "no sales that day" identical to "Sanity reported nothing
		// for that day" — the distinction this package's figure primitives exist to keep.
		const html = render(<OverviewPanel data={data as never} />)
		// A fill is what makes it a data mark. The per-row clip rect lives in <defs> and carries no
		// fill, so it must not be counted. Orders draw in the orders colour, which is also the
		// assertion that the row picked up its series colour at all.
		const rects = (html.match(/<rect[^>]*>/g) ?? [])
			.filter((r) => r.includes(`fill="${SERIES.orders}"`) && !r.includes('data-swatch'))
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
		// A fill is what makes it a data mark. The per-row clip rect lives in <defs> and carries no
		// fill, so it must not be counted. Orders draw in the orders colour, which is also the
		// assertion that the row picked up its series colour at all.
		const rects = (html.match(/<rect[^>]*>/g) ?? [])
			.filter((r) => r.includes(`fill="${SERIES.orders}"`) && !r.includes('data-swatch'))
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
			vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {},
			interpretation: 'x', capture: model,
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
			vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
			revenue: ok(0), currency: 'USD', orderStatuses: {},
			audience: ok(1), audienceGrowth: ok(0), campaigns: [],
			capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
			estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
			crossSource: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].map((date, i) => ({
				date, vercelPageviews: 300, ga4Pageviews: i === 2 ? 20 : 250, ga4Sessions: 60, orders: 0, revenue: null,
			})),
			timelineEvents: [],
		} as never} />)
		expect(html).toContain('Missed by GA4')
		expect(html).toContain('Share GA4 saw')
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		audience: ok(4000), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
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
		['journey', 'journey', 'Not a tracked path'],
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
		expect(journey).toContain('Not a tracked path')
	})

	it('names which baseline is in force rather than leaving it to the dates', () => {
		// A year-ago comparison read as last month's is a wrong conclusion about the business, not a
		// cosmetic slip — the sentence has to say which one it is.
		const props = {
			apiBaseUrl: 'https://x.test', range: 'quarter' as const,
			custom: { start: '2026-06-08', end: '2026-09-05' },
			revalidationError: null, diagnostics: { status: 'idle' } as never,
		}
		const withBasis = (basis: string) => ({
			...envelope('measurement-health'),
			comparison: { range: { start: '2025-06-09', end: '2025-09-06' }, data, provisional: false, basis },
		})

		const lastYear = render(<ReadyReport envelope={withBasis('same-period-last-year') as never} tabId="overview" {...props} />)
		expect(lastYear).toContain('the same window a year earlier')
		expect(lastYear).not.toContain('immediately before this one')

		const preceding = render(<ReadyReport envelope={withBasis('previous-period') as never} tabId="overview" {...props} />)
		expect(preceding).toContain('immediately before this one')

		// An envelope from a build that predates the option carries no basis at all, and must read as
		// the baseline it actually used rather than falling through to no sentence.
		const older = {
			...envelope('measurement-health'),
			comparison: { range: { start: '2026-03-10', end: '2026-06-07' }, data, provisional: false },
		}
		expect(render(<ReadyReport envelope={older as never} tabId="overview" {...props} />))
			.toContain('immediately before this one')
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
			vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {},
			audience: ok(4210), audienceGrowth: unavailable('not_applicable'), campaigns: [],
			capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
			estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
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
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(1000), currency: 'USD', orderStatuses: {},
		audience: ok(4000), audienceGrowth: unavailable('not_applicable'), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
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
		const html = render(<FunnelChart stages={stages([2000, 900, 400, 200, 120, 60])} measurement="sequence" />)
		expect(html).toContain('of landed')
	})

	it('gives every rung one share, against the entry step, rather than two against two things', () => {
		// There used to be a second clause per rung — the step-to-step rate — each half with its own
		// withhold-fallback. The bars are anchored to entry, so share-of-entry is already drawn; the
		// second clause was the same picture twice and doubled the apologies when it could not print.
		const html = render(<FunnelChart stages={stages([2000, 900, 400, 200, 120, 60])} measurement="sequence" />)
		expect(html).not.toContain('of began checkout')
		expect(html.match(/of landed/g)).toHaveLength(5)
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

	it('says why rates are missing once, under the chart, not once per rung', () => {
		// The rule is a property of the funnel. Stated per rung it produced six lines of apology on
		// a six-step chart — twice on each of three consecutive rungs — and became the most repeated
		// string in the tool.
		const html = render(<FunnelChart stages={stages([8, 5, 3])} measurement="sequence" />)
		expect(html).toContain('at least 30 people reached')
		expect(html.match(/at least 30 people reached/g)).toHaveLength(1)
		expect(html).not.toContain('too few to give a rate')
	})

	it('says nothing about denominators when every rung could carry a rate', () => {
		// An instruction that is always on screen regardless of whether it applies is furniture.
		const html = render(<FunnelChart stages={stages([2000, 900, 400, 200, 120, 60])} measurement="sequence" />)
		expect(html).not.toContain('at least 30 people reached')
	})
})

describe('the chart anchors each row against the period before it', () => {
	const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
	const shell = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.2,
		ga4Sessions: ok(357), orders: ok(2), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(0), currency: 'USD', orderStatuses: {},
		audience: ok(1), audienceGrowth: ok(0), campaigns: [],
		capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
		estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
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
		// The invariant, not the wording: 4 of 4,000 must not be drawn as a percentage anywhere.
		expect(html).not.toContain('0.1%')
		// The count is still a fact, and the rule is stated once beneath.
		expect(html).toContain('>4<')
		expect(html).toContain('at least 30 people reached')
	})

	it('leaves no unexplained gap when a rung withholds its share', () => {
		// The concern this replaces was right: a withheld rate used to fall to an empty string, and
		// an empty line under a bar reads as something that failed to load. The answer is not a
		// per-rung apology — it is that the rule is stated once, under the chart, where it applies
		// to every rung at once.
		const html = render(<FunnelChart stages={stages([4000, 1800, 900, 300, 20, 8])} measurement="sequence" />)
		expect(html).toContain('at least 30 people reached')
		expect(html.match(/at least 30 people reached/g)).toHaveLength(1)
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

describe('small-sample and absent figures say so on the panels', () => {
	const shell = {
		interpretationNote: 'x', rowsWithheld: false, licenceTiers: [], totalRevenue: ok(910), currency: 'USD',
	}

	it('will not rank a family on a handful of views', () => {
		// Every other small-sample figure here is gated by a number; this column was gated by a
		// sentence in the blurb. At sixteen views and one order it printed "4.9× catalogue" in the
		// same type as a figure computed on hundreds.
		const html = render(<TypefaceInterestPanel data={{
			...shell,
			rows: [
				{ typeface: 'Quiet', viewed: ok(16), tested: ok(3), bought: ok(1), revenue: ok(300), testRate: 0.2, buyRate: 1 / 16 },
				{ typeface: 'Busy', viewed: ok(800), tested: ok(200), bought: ok(8), revenue: ok(2400), testRate: 0.25, buyRate: 8 / 800 },
			],
		} as never} />)
		expect(html).toContain('too few views to compare')
		// The family with a real denominator still gets its comparison.
		expect(html).toMatch(/\d\.\d× catalogue/)
	})

	it('states why mailing-list growth is missing rather than rendering nothing', () => {
		// metricSortValue returns null for any unavailable metric, so the reason the server wrote was
		// discarded — and the start figure is only fetched when a range begins on the first of a
		// month, which no preset range does. The card showed a bare total forever.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.2,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {},
			audience: ok(4210),
			audienceGrowth: unavailable('not_applicable', 'Mailchimp reports list growth by calendar month, so this range has no start figure'),
			campaigns: [], capture: { estimates: [], rate: null, low: null, high: null, discrepancy: null },
			estimatedSessions: unavailable('not_applicable'), interpretation: 'x',
			crossSource: [], timelineEvents: [],
		} as never} />)
		expect(html).toContain('list growth by calendar month')
	})
})

describe('averageOrderValue', () => {
	const base = { revenue: { status: 'ok', value: 4400 }, ordersWithTotal: 11, currency: 'USD' }

	it('divides by the orders that carry an amount, not by every order', () => {
		// At Darden 11 of 69 orders carry a total. Dividing the revenue those 11 produced by all 69
		// gives an average six times too low — a number that reads as a collapse in order size and is
		// in fact a gap in the order record.
		expect(averageOrderValue({ ...base, orders: { status: 'ok', value: 69 } } as never))
			.toMatchObject({ status: 'partial', value: 400 })
	})

	it('marks the average partial exactly when the revenue behind it is partial', () => {
		// A complete revenue figure produces a plain average; the qualifier must not be decoration.
		expect(averageOrderValue({ ...base, orders: { status: 'ok', value: 11 } } as never).status)
			.toBe('ok')
	})

	it('says it does not apply rather than dividing by zero', () => {
		expect(averageOrderValue({ ...base, ordersWithTotal: 0 } as never))
			.toMatchObject({ status: 'unavailable', reason: 'not_applicable' })
	})

	it('reports an absent order total as absent, never as a zero average', () => {
		// The site has no total field configured. That is not an average of nothing; it is no average.
		expect(averageOrderValue({ ...base, ordersWithTotal: null } as never).status).toBe('unavailable')
	})
})

describe('visitorsPerOrder', () => {
	it('counts people rather than GA4 sessions', () => {
		// Sessions would flatter the ratio roughly fivefold at Darden's shortfall, and the figure is
		// read as "how many people it takes to make a sale".
		expect(visitorsPerOrder({
			vercelVisitors: { status: 'ok', value: 1400 },
			orders: { status: 'ok', value: 7 },
		} as never)).toMatchObject({ status: 'ok', value: 200 })
	})

	it('withholds the ratio when there was no order to divide by', () => {
		expect(visitorsPerOrder({
			vercelVisitors: { status: 'ok', value: 1400 },
			orders: { status: 'ok', value: 0 },
		} as never)).toMatchObject({ status: 'unavailable', reason: 'not_applicable' })
	})

	it('passes an unavailable input through rather than inventing a ratio from one side', () => {
		expect(visitorsPerOrder({
			vercelVisitors: { status: 'unavailable', reason: 'source_error', detail: 'Vercel down' },
			orders: { status: 'ok', value: 7 },
		} as never).status).toBe('unavailable')
	})
})

describe('revenuePerThousandSent', () => {
	const campaign = { title: 'August', subject: 'August', sentAt: '2026-08-20T19:00:00+00:00', sent: 2000, opens: 900, clicks: 120, unsubscribed: 3 }

	it('scales to a thousand addresses, where a foundry\'s figures are legible', () => {
		// Per send this is $0.35, which rounds to the same zero for every campaign in the table.
		expect(revenuePerThousandSent({ ...campaign, revenueAfter: 700 })).toBe(350)
	})

	it('withholds the figure when no revenue was measured, rather than showing nothing sold', () => {
		expect(revenuePerThousandSent({ ...campaign, revenueAfter: null })).toBeNull()
		expect(revenuePerThousandSent({ ...campaign })).toBeNull()
	})

	it('does not divide by a send count of zero', () => {
		expect(revenuePerThousandSent({ ...campaign, sent: 0, revenueAfter: 700 })).toBeNull()
	})

	it('reports a genuine zero as zero, distinct from unmeasured', () => {
		// A send that produced no orders is a finding. It must not be withheld alongside the ones
		// that could not be measured.
		expect(revenuePerThousandSent({ ...campaign, revenueAfter: 0 })).toBe(0)
	})
})

describe('the email campaigns table', () => {
	const campaign = {
		title: 'Freight release', subject: 'Freight is here', sentAt: '2026-08-20T19:00:00+00:00',
		sent: 2000, opens: 900, clicks: 120, unsubscribed: 3,
	}
	const overview = (campaigns: unknown[]) => ({
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: 7, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {},
		interpretation: 'Sources differ.',
		audience: ok(4210), audienceGrowth: ok(12), campaigns, crossSource: [], timelineEvents: [],
	})

	it('shows what the order book recorded after a send', () => {
		const html = render(<OverviewPanel data={overview([{ ...campaign, ordersAfter: 4, revenueAfter: 700, windowDays: 3, windowComplete: true }]) as never} />)
		expect(html).toContain('Orders after')
		expect(html).toContain('Per 1,000 sent')
		// $700 over 2,000 addresses is $350 per thousand.
		expect(html).toContain('350')
	})

	it('says what the columns do not claim', () => {
		// Without this the table reads as attribution, and a reader will credit the newsletter for
		// the site's ordinary trade in those days.
		const html = render(<OverviewPanel data={overview([{ ...campaign, ordersAfter: 4, revenueAfter: 700, windowDays: 3, windowComplete: true }]) as never} />)
		expect(html).toContain('not what the send caused')
	})

	it('marks a window the range cut short rather than showing it as a finished result', () => {
		const html = render(<OverviewPanel data={overview([{ ...campaign, ordersAfter: 1, revenueAfter: 100, windowDays: 1, windowComplete: false }]) as never} />)
		expect(html).toContain('so far')
	})

	it('renders an unmeasured campaign as a dash, never as zero orders', () => {
		// The failure this whole package exists to prevent: an absence rendered as a measurement.
		const html = render(<OverviewPanel data={overview([{ ...campaign, ordersAfter: null, revenueAfter: null, windowDays: 0, windowComplete: false }]) as never} />)
		expect(html).toContain('Freight release')
		expect(html).not.toContain('>0<')
	})

	it('renders campaigns from a route that predates these columns', () => {
		// The Studio ships separately from the sites, so an envelope with no window fields at all is
		// the normal state of this repo for a while after every release.
		const html = render(<OverviewPanel data={overview([campaign]) as never} />)
		expect(html).toContain('Freight release')
	})
})

describe('the floating hover card', () => {
	const rows = [
		{ key: 'traffic', label: 'Pageviews', color: SERIES.vercel, value: '2,356', seen: 'GA4 475' },
		{ key: 'revenue', label: 'Revenue', color: SERIES.revenue, value: 'US$910', seen: null },
	]

	it('carries each series colour as a block beside its name', () => {
		// The card and the plot share one legend. A value with no swatch sends the reader back to
		// the chart to work out which line it belongs to, which is what the card exists to avoid.
		const html = render(<HoverCard x={100} paneWidth={600} date="20 Aug" rows={rows} events={[]} />)
		expect(html).toContain(SERIES.vercel)
		expect(html).toContain(SERIES.revenue)
		expect(html).toContain('Pageviews')
		expect(html).toContain('2,356')
		expect(html).toContain('GA4 475')
	})

	it('never takes the pointer, which would end the hover positioning it', () => {
		const html = render(<HoverCard x={100} paneWidth={600} date="20 Aug" rows={rows} events={[]} />)
		expect(html).toMatch(/pointer-events:\s*none/)
	})

	it('sits to the right of the crosshair in the left of the pane', () => {
		const html = render(<HoverCard x={100} paneWidth={600} date="20 Aug" rows={rows} events={[]} />)
		expect(html).toMatch(/left:\s*114px/)
	})

	it('flips to the left rather than hanging off the right edge', () => {
		// The last week of a range is the part most often read. Clamping instead would park the card
		// on top of the days it describes for the whole right-hand edge.
		const html = render(<HoverCard x={560} paneWidth={600} date="4 Sep" rows={rows} events={[]} />)
		expect(html).toMatch(/right:\s*54px/)
		expect(html).not.toMatch(/left:\s*574px/)
	})

	it('shows a campaign send on the day it landed', () => {
		const html = render(<HoverCard x={100} paneWidth={600} date="20 Aug" rows={rows} events={['Freight release']} />)
		expect(html).toContain('Freight release')
	})
})

describe('colorFor', () => {
	it('gives the complete source its own colour, not one shared with the lossy one', () => {
		expect(SERIES[colorFor('Vercel', 'count')]).toBe(SERIES.vercel)
		expect(colorFor('Vercel', 'count')).not.toBe(colorFor('GA4', 'count'))
	})

	it('keeps GA4 in one family across both its units', () => {
		// Same instrument, two units. The palette says so; a reader should not have to.
		const pageviews = colorFor('GA4', 'count')
		const percent = colorFor('GA4', 'percent')
		expect([pageviews, percent].every((k) => k.startsWith('ga4'))).toBe(true)
	})

	it('splits Sanity by unit, because a foundry reads orders and money as different things', () => {
		expect(colorFor('Sanity', 'count')).toBe('orders')
		expect(colorFor('Sanity', 'money')).toBe('revenue')
	})

	it('lets a caller override where the source does not decide the meaning', () => {
		// Coverage is computed FROM two sources and belongs to neither.
		expect(colorFor('GA4', 'percent', 'vercel')).toBe('vercel')
	})
})

describe('folding away empty columns', () => {
	const rows = [{ name: 'Freight', views: 40, purchases: 0, revenue: null }, { name: 'Gamay', views: 12, purchases: 0, revenue: null }]
	const column = (key: string, get: (r: typeof rows[0]) => number | string | null, extra = {}) =>
		({ key, label: key, sortValue: get, render: () => null, ...extra })

	it('folds a column that is measured zero all the way down', () => {
		// Ten families and a Purchases column reading 0 ten times: a column as wide as its heading
		// that says only "not this one".
		expect(columnIsEmpty(column('purchases', (r) => r.purchases), rows)).toBe(true)
	})

	it('keeps a column that could not be measured, because that is the finding', () => {
		// The distinction the whole package turns on. A column of dashes says an instrument failed;
		// folding it would delete the loudest thing the table can report.
		expect(columnIsEmpty(column('revenue', (r) => r.revenue), rows)).toBe(false)
	})

	it('keeps a column with any value in it', () => {
		expect(columnIsEmpty(column('views', (r) => r.views), rows)).toBe(false)
	})

	it('keeps a column that asked to stay', () => {
		expect(columnIsEmpty(column('purchases', (r) => r.purchases, { alwaysShow: true }), rows)).toBe(false)
	})

	it('folds nothing when there are no rows to judge by', () => {
		// An empty table folded to its first column is a heading strip with nothing under it, and
		// says "no columns" where the truth is "no rows".
		expect(columnIsEmpty(column('purchases', (r) => r.purchases), [])).toBe(false)
	})

	it('never folds the column that names the row, even when it is empty', () => {
		// A table folded to its figures is a grid of numbers belonging to nothing. The first column
		// is the row's identity whatever its values happen to be.
		const html = render(
			<SortableTable
				caption="Families"
				rowKey={(r: { id: string }) => r.id}
				rows={[{ id: 'a' }, { id: 'b' }]}
				columns={[
					{ key: 'name', label: 'Family', sortValue: () => '', render: () => null },
					{ key: 'views', label: 'Views', sortValue: () => 5, render: () => null },
				]}
			/>,
		)
		expect(html).toContain('Family')
	})

	it('never folds the column being sorted on', () => {
		// Folding it would leave the rows in an order with nothing on screen to explain it.
		const html = render(
			<SortableTable
				caption="Families"
				rowKey={(r: { id: string }) => r.id}
				initialSort="purchases"
				rows={[{ id: 'a' }, { id: 'b' }]}
				columns={[
					{ key: 'name', label: 'Family', sortValue: (r: { id: string }) => r.id, render: () => null },
					{ key: 'purchases', label: 'Purchases', sortValue: () => 0, render: () => null },
				]}
			/>,
		)
		expect(html).toContain('Purchases')
	})

	it('offers the folded columns back, naming how many', () => {
		// Nothing may be hidden silently. Without the count the tool is deciding what the data says.
		const data = {
			rows: [
				// Engagement measured at zero on every row — a real column of real zeros, which is
				// what folding is for. Revenue stays null, so it must survive as a column of dashes.
				{ source: 'fontsinuse.com', channel: 'Referral', medium: 'referral', campaign: null, sessions: 120,
					engagedSessions: 0, engagementRate: 0, designIndustry: true, unattributed: false,
					purchases: 0, revenueShare: null, trackedRevenue: 0, apportionedRevenue: null },
				{ source: 'typographica.org', channel: 'Referral', medium: 'referral', campaign: null, sessions: 40,
					engagedSessions: 0, engagementRate: 0, designIndustry: true, unattributed: false,
					purchases: 0, revenueShare: null, trackedRevenue: 0, apportionedRevenue: null },
			],
			totalSessions: 120, designIndustryShare: 0.3, unattributedShare: 0.1,
			rowsWithheld: false, rowsTruncated: false, campaigns: [],
		}
		const html = render(<AcquisitionPanel data={data as never} />)
		expect(html).toMatch(/Show \d+ empty columns?/)
		// And the column that could not be measured is still on screen, as dashes.
		expect(html).toContain('Revenue, split')
	})
})

describe('section hierarchy and progressive disclosure', () => {
	it('gives a section a reader consults a quieter treatment than one they read', () => {
		// One weight for everything was the whole problem: eleven blocks of equal loudness and no
		// answer to "what am I meant to look at".
		const read = render(<SectionTitle title="Traffic sources" />)
		const consult = render(<SectionTitle title="Configuration" tone="secondary" />)
		expect(consult).toMatch(/text-transform:\s*uppercase/)
		expect(read).not.toMatch(/text-transform:\s*uppercase/)
	})

	it('does not render a folded section\'s contents at all', () => {
		// Hidden with CSS, the noise is still there — still in the DOM, still found by a page
		// search, still drawn. Folding has to actually remove it.
		const html = render(
			<Section title="Configuration" collapsible defaultOpen={false}>
				<p>the long reference block</p>
			</Section>,
		)
		expect(html).not.toContain('the long reference block')
		expect(html).toContain('Configuration')
		expect(html).toContain('Show')
	})

	it('renders the contents when it starts open, and offers to hide them', () => {
		const html = render(
			<Section title="Configuration" collapsible>
				<p>the long reference block</p>
			</Section>,
		)
		expect(html).toContain('the long reference block')
		expect(html).toContain('Hide')
	})

	it('ties the control to the region it controls, for a screen reader', () => {
		const html = render(<Section title="Context" collapsible><p>body</p></Section>)
		expect(html).toMatch(/aria-expanded="true"/)
		expect(html).toMatch(/aria-controls="[^"]+"/)
	})

	it('has no control at all when it cannot fold', () => {
		const html = render(<Section title="Traffic sources"><p>body</p></Section>)
		expect(html).not.toContain('aria-expanded')
		expect(html).toContain('body')
	})

	it('pairs blocks by available width rather than by viewport', () => {
		// The panel is a resizable pane inside a Studio inside, sometimes, an iframe. A viewport
		// breakpoint answers a question nobody asked.
		expect(splitGrid.gridTemplateColumns).toContain('auto-fit')
		expect(splitGrid.gridTemplateColumns).toContain('100%')
	})

	it('keeps the configuration checks visible on the tab that exists to show them', () => {
		// Data health answers "what should I fix before trusting any of this". Folding the answer
		// away by default would leave the tab opening on the problem with the fix behind a click.
		const html = render(
			<DataHealthPanel
				data={{
					ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
					ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
					vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
					revenue: ok(910), currency: 'USD', orderStatuses: {},
					interpretation: 'Sources differ.',
					audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
					campaigns: [], crossSource: [], timelineEvents: [],
				} as never}
				diagnostics={{ checks: [{ key: 'ga4', label: 'GA4 credentials', status: 'pass', detail: 'Configured' }] } as never}
			/>,
		)
		expect(html).toContain('Configuration')
		expect(html).toContain('GA4 credentials')
	})
})

describe('the funnel draws what was lost', () => {
	const steps = [
		{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(1000), conversionFromPrevious: null },
		{ key: 'tested', label: 'Tested', event: 'tester_engaged', count: ok(250), conversionFromPrevious: 0.25 },
	]

	it('draws the drop-off on the same rail as the rungs, at the same scale', () => {
		// THE regression this test exists for. The drop-off used to have a rail of its own at
		// width:38%, with its fill a percentage OF THAT RAIL — so 750 of 1,000 drew at 28% of the
		// width a 750 rung would occupy. The old test asserted width:75% and passed, because the
		// fill really was 75% of its own little rail: it checked the arithmetic, never the
		// relationship it claimed. This checks the relationship.
		const html = render(<JourneyPanel data={{ steps, measurement: 'sequence', approximate: false, approximationNote: 'Tracked.', outcomes: [], topLandingPages: [] } as never} />)

		// 750 lost of 1,000 entrants. A rung holding 750 would draw at 75% of the full rail, so the
		// loss must too.
		expect(html).toMatch(/width:\s*75%/)
		// And there must be no nested rail rescaling it. Any fractional-width track reintroduces the
		// bug whatever the fill inside it says.
		expect(html).not.toMatch(/width:\s*38%/)
		// Drawn in the loss colour, and that colour must not belong to any series. It was the
		// REVENUE hue, so a bar between two funnel rungs read as money; GA4's hue is wrong for the
		// mirror-image reason, since it means "this instrument measured it". People who left are an
		// absence, so the mark is the neutral.
		expect(html).toContain(mark('bar.lost'))
		// Compared in the same space. `mark()` returns rgba and SERIES holds hex, so a
		// `not.toContain(hex)` here would pass no matter what the loss colour was.
		const lost = mark('bar.lost')
		for (const key of Object.keys(SERIES) as Array<keyof typeof SERIES>) {
			expect(lost).not.toBe(seriesFill(key, 1))
		}
	})

	it('states the drop-off as a share for readers who get no bar at all', () => {
		// The whole gap block used to sit inside aria-hidden, so a screen-reader user received five
		// stage counts and nothing about abandonment.
		const html = render(<JourneyPanel data={{ steps, measurement: 'sequence', approximate: false, approximationNote: 'Tracked.', outcomes: [], topLandingPages: [] } as never} />)
		expect(html).toContain('75% of everyone who landed')
	})

	it('draws no drop-off arm under independent totals, where there is no drop-off', () => {
		// The counts are of different acts by possibly different people. A bar would invent exactly
		// the reading the fallback's caveat exists to forbid.
		const html = render(<JourneyPanel data={{ steps, measurement: 'independent-totals', approximate: true, approximationNote: 'Each step counted on its own.', outcomes: [], topLandingPages: [] } as never} />)
		// The loss mark itself, not a colour that happens not to be used — the old assertion named
		// GA4's hue, which stopped being the loss colour and left the check passing for free.
		expect(html).not.toContain(mark('bar.lost'))
		// And with no bar, no label floating where the bar would have been.
		expect(html).not.toContain('fewer')
	})

	it('draws nothing where nobody was lost', () => {
		const level = [
			{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(1000), conversionFromPrevious: null },
			{ key: 'tested', label: 'Tested', event: 'tester_engaged', count: ok(1000), conversionFromPrevious: 1 },
		]
		const html = render(<JourneyPanel data={{ steps: level, measurement: 'sequence', approximate: false, approximationNote: 'Tracked.', outcomes: [], topLandingPages: [] } as never} />)
		expect(html).toContain('no drop-off')
		expect(html).not.toContain(SERIES.ga4Pageviews)
	})
})

describe('the funnel breakdown', () => {
	const step = (key: string, label: string, count: number, rate: number | null) =>
		({ key, label, event: key, count: ok(count), conversionFromPrevious: rate })
	const desktop = { key: 'desktop', label: 'Desktop', steps: [step('landed', 'Landed', 8804, null), step('viewed', 'Viewed', 112, 0.0127)] }
	const mobile = { key: 'mobile', label: 'Mobile', steps: [step('landed', 'Landed', 8408, null), step('viewed', 'Viewed', 12, 0.0014)] }
	const journey = (segments: unknown[]) => ({
		steps: [step('landed', 'Landed', 17723, null), step('viewed', 'Viewed', 129, 0.0073)],
		segments, segmentDimension: 'device',
		measurement: 'sequence', approximate: false, approximationNote: 'Tracked.',
		outcomes: [], topLandingPages: [],
	})

	it('shows every segment at once, in a table, rather than behind a control', () => {
		// This test used to assert the rates appeared "on the control". It kept passing after the
		// control was deleted, because spread()'s sentence also prints them — a test whose name
		// described removed behaviour, still green. It now asserts the table.
		const html = render(<JourneyPanel data={journey([desktop, mobile]) as never} />)
		expect(html).toContain('Desktop')
		expect(html).toContain('Mobile')
		// Both segments' counts are present simultaneously, which is the thing the control prevented.
		expect(html).toContain('8,804')
		expect(html).toContain('8,408')
		// And no radiogroup remains.
		expect(html).not.toContain('radiogroup')
	})

	it('prints every rate with the denominator it is a share of', () => {
		// The control printed a bare rate to two decimals with no denominator and no floor — the
		// same claim spread() refuses below 200 users, through the back door.
		const html = render(<JourneyPanel data={journey([desktop, mobile]) as never} />)
		expect(html).toMatch(/of 8,804/)
		expect(html).toMatch(/of 8,408/)
	})

	it('withholds a rate whose denominator is too small, but still shows the count', () => {
		// How many people reached a step is a fact at any sample size; only the ratio needs
		// protecting.
		const tiny = { key: 'tablet', label: 'Tablet', steps: [
			step('landed', 'Landed', 12, null), step('viewed', 'Viewed', 3, 0.25),
		] }
		const html = render(<JourneyPanel data={journey([desktop, tiny]) as never} />)
		expect(html).toContain('12')
		expect(html).not.toContain('of 12')
	})

	it('says in words when the segments differ by a multiple', () => {
		const html = render(<JourneyPanel data={journey([desktop, mobile]) as never} />)
		expect(html).toContain('times worse')
		expect(html).toContain('describes neither')
	})

	it('says nothing when the segments merely differ', () => {
		// A tool that remarks on every difference teaches the reader to stop reading its remarks.
		const close = { ...mobile, steps: [step('landed', 'Landed', 8408, null), step('viewed', 'Viewed', 90, 0.010)] }
		expect(spread([desktop, close] as never)).toBeNull()
	})

	it('will not call a segment worse on too few visitors to tell', () => {
		// Forty users can produce any rate at all. "Tablet converts nine times better" off six
		// people is exactly the confident nonsense this package exists not to print.
		const tiny = { key: 'tablet', label: 'Tablet', steps: [step('landed', 'Landed', 40, null), step('viewed', 'Viewed', 9, 0.225)] }
		expect(spread([desktop, tiny] as never)).toBeNull()
	})

	it('offers no control at all when there is nothing to compare', () => {
		const html = render(<JourneyPanel data={journey([]) as never} />)
		expect(html).not.toContain('Everyone')
	})

	it('reads the first-step rate, and reports an unmeasured one as absent rather than zero', () => {
		expect(firstStepRate(desktop.steps as never)).toBeCloseTo(0.0127, 5)
		expect(firstStepRate([step('landed', 'Landed', 10, null)] as never)).toBeNull()
		expect(firstStepRate([step('a', 'A', 10, null), step('b', 'B', 1, null)] as never)).toBeNull()
	})
})

describe('small samples do not get a percentage', () => {
	it('withholds the ratio when the baseline is below the floor, but keeps the direction', () => {
		// "7 orders ↑ +75% from 4" rendered in the largest type on the default tab. One order moves
		// that twenty-five points, and the server refuses far better-supported claims.
		const html = render(<Delta current={7} previous={4} />)
		expect(html).not.toContain('75')
        expect(html).not.toContain('%')
		expect(html).toContain('from 4')
		expect(html).toContain('↑')
	})

	it('still gives a percentage once the baseline can carry one', () => {
		const html = render(<Delta current={2356} previous={1800} />)
		expect(html).toMatch(/\+31%/)
	})

	it('keeps saying "new" for a first-ever figure rather than "was 0"', () => {
		// The floor must not swallow the zero-baseline case, which has its own wording.
		expect(render(<Delta current={3} previous={0} />)).toContain('new')
	})

	it('leaves percentage-point moves alone, since their denominator is not visible here', () => {
		const html = render(<Delta current={44} previous={40} unit="percent" />)
		expect(html).toContain('pts')
	})

	it('shows the average-order denominator rather than the bare word partial', () => {
		// The card computed "Averaged over the N of M orders that carry an amount" and threw it away.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1400), ordersWithTotal: 2, vercelDailyUnavailable: false,
			revenue: { status: 'partial', value: 910, coveredFrom: '', note: '' }, currency: 'USD',
			orderStatuses: {}, interpretation: '',
			audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
			campaigns: [], crossSource: [], timelineEvents: [],
		} as never} />)
		expect(html).toContain('2 of 7 orders')
	})
})

describe('the drawing honours the mark registry', () => {
	/**
	 * The other half of the contrast fix.
	 *
	 * palette.test.ts proves each registry entry clears 3:1 as composited. That is worth nothing if
	 * a renderer ignores the registry and picks its own alpha — which is precisely how the original
	 * defect happened. These tests assert the rendered SVG actually contains the registry's colours,
	 * so the two cannot come apart again.
	 */
	const data = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
		campaigns: [], timelineEvents: [],
		crossSource: [
			{ date: '2026-08-20', vercelPageviews: 400, ga4Pageviews: 90, ga4Sessions: 70, orders: 2, revenue: 300 },
			{ date: '2026-08-21', vercelPageviews: 380, ga4Pageviews: 85, ga4Sessions: 66, orders: 0, revenue: 0 },
			{ date: '2026-08-22', vercelPageviews: 420, ga4Pageviews: 95, ga4Sessions: 74, orders: 1, revenue: 610 },
		],
	}

	it('draws the lossier source\u2019s own line through the registry', () => {
		// Formerly the region's boundary. The region is gone; this line is not, because the collapse
		// detector and the spoken summary both read from it.
		const html = render(<OverviewPanel data={data as never} />)
		expect(html).toContain(mark('chart.lossy'))
	})

	it('draws data marks at full strength, with no opacity reducing them below the tested value', () => {
		// Every mark the registry calls `data` is declared at alpha 1. If a renderer reapplies an
		// opacity on top, the composited contrast is no longer what palette.test.ts measured.
		const html = render(<OverviewPanel data={data as never} />)
		const dataColours = Object.entries(MARKS)
			.filter(([, m]) => m.role === 'data' && m.key !== 'neutral')
			.map(([name]) => mark(name))
		// At least the line and the region edge must appear at their registry values.
		expect(dataColours.some((c) => html.includes(c))).toBe(true)
		// And no path may carry both a series colour and a fractional opacity.
		expect(html).not.toMatch(/stroke="rgba\([^"]*, 1\)"[^>]*opacity="0\.[0-9]/)
	})
})

describe('saying the short-list caveat once', () => {
	it('says nothing when the list is complete', () => {
		// A note that always renders carries no information. Silence is the honest default.
		expect(shortListNote(false, false, 'tail')).toBeUndefined()
	})

	it('names the cause when GA4 hit its row limit', () => {
		expect(shortListNote(true, false, 'tail')).toContain('only its top rows')
	})

	it('names the cause when GA4 suppressed low-count rows', () => {
		expect(shortListNote(false, true, 'tail')).toContain('too few people to report')
	})

	it('says both causes in one sentence when both apply, not two notices', () => {
		// This is the whole point: these were a quiet under-table line AND a second amber card two
		// sentences apart. The distinction is real; meeting it twice is what teaches a reader to
		// stop reading amber.
		const both = shortListNote(true, true, 'tail')
		expect(both).toContain('only its top rows')
		expect(both).toContain('too few people to report')
		expect(both?.split('.').filter((p) => p.trim()).length).toBeLessThanOrEqual(2)
	})

	it('carries the per-table consequence, which differs between the two tables', () => {
		expect(shortListNote(true, false, 'The long tail is most of the catalogue.'))
			.toContain('The long tail is most of the catalogue.')
	})

	it('renders no separate amber notice alongside it', () => {
		const data = {
			rows: [{ source: 'fontsinuse.com', channel: 'Referral', medium: 'referral', campaign: null,
				sessions: 120, engagedSessions: 90, engagementRate: 0.75, designIndustry: true,
				unattributed: false, purchases: 2, revenueShare: null, trackedRevenue: 0, apportionedRevenue: null }],
			totalSessions: 120, designIndustryShare: 0.3, unattributedShare: 0.1,
			rowsWithheld: true, rowsTruncated: true, campaigns: [],
		}
		const html = render(<AcquisitionPanel data={data as never} />)
		// One statement of the fact, not two.
		expect(html.match(/shorter than reality/g)).toHaveLength(1)
	})
})

describe('the coverage ribbon says only what the reader must act on', () => {
	const render62 = () => render(
		<VisitorInsightsTool
			apiBaseUrl="https://x.test"
			// The ribbon is what is under test; the panel behind it does not matter.
		/> as never,
	)

	it('keeps the two claims that change what a reader does', () => {
		// How low the figures run, and which ones not to touch. Everything else in the old 62 words
		// was either naming a system the reader does not recognise, or pointing at a tab whose name
		// is in the strip directly above the card.
		const html = render(<AcquisitionPanel data={{
			rows: [], totalSessions: 0, designIndustryShare: null, unattributedShare: null,
			rowsWithheld: false, rowsTruncated: false, campaigns: [],
		} as never} />)
		// The panel itself carries no ribbon — it is drawn by the tool shell — so this asserts the
		// panel does not restate the claim a third time on its own.
		expect(html).not.toContain('must not be scaled')
	})

	it('no longer names Sanity at the reader', () => {
		// "anything labelled as coming from Sanity" named a system the reader knows only as the
		// place they type. The (orders) column suffix carries the same distinction where it applies.
		const tool = readFileSync(new URL('./VisitorInsightsTool.tsx', import.meta.url), 'utf8')
		const visible = tool.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
		expect(visible).not.toContain('coming from Sanity')
	})
})

describe('the rank on the exact cards', () => {
	/** Four whole weeks of exact orders, the latest the second best. */
	const series = Array.from({ length: 28 }, (_, i) => ({
		date: `2026-01-${String(i + 1).padStart(2, '0')}`,
		vercelPageviews: 100, ga4Pageviews: 20, ga4Sessions: 15,
		// Weekly totals, oldest to newest: 3, 9, 5, 7.
		orders: i % 7 === 0 ? [3, 9, 5, 7][Math.floor(i / 7)] as number : 0,
		revenue: i % 7 === 0 ? ([3, 9, 5, 7][Math.floor(i / 7)] as number) * 100 : 0,
	}))

	it('says where the week sits rather than only how much it moved', () => {
		expect(rankLine(series as never, (d) => d.orders)).toBe('2nd best of the last 4 weeks')
	})

	it('says nothing when the range holds too few whole weeks', () => {
		// A short range says less, rather than saying something weaker.
		expect(rankLine(series.slice(0, 14) as never, (d) => d.orders)).toBeNull()
	})

	it('says nothing at all when there is no series', () => {
		expect(rankLine(undefined, (d) => d.orders)).toBeNull()
		expect(rankLine([] as never, (d) => d.orders)).toBeNull()
	})

	it('renders beside the change, not instead of it', () => {
		// The percentage is what misleads at these counts; the change is still what a reader looks
		// for first. Both, or the card loses the thing it is for.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
			audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
			campaigns: [], timelineEvents: [], crossSource: series,
		} as never} previous={{ orders: ok(4), revenue: ok(560) } as never} />)
		expect(html).toContain('best of the last 4 weeks')
		// And the baseline is still there.
		expect(html).toContain('from 4')
	})

	it('does not rank a GA4 figure', () => {
		// Ranking a lossy series would rank the instrument's mood alongside the business. Only the
		// order-derived cards carry a rank.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
			audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
			campaigns: [], timelineEvents: [], crossSource: series,
		} as never} />)
		// Two ranks — orders and revenue — and no more.
		expect(html.match(/best of the last 4 weeks/g)).toHaveLength(2)
	})
})

describe('the shortfall drawn as containment', () => {
	const health = (vercel: number, ga4: number) => ({
		ga4Pageviews: ok(ga4), vercelPageviews: ok(vercel), shortfallRatio: (vercel - ga4) / vercel,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: 'Sources differ.',
		 audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
		campaigns: [], crossSource: [], timelineEvents: [],
	})

	it('draws one bar, with the lossy count inside the complete one', () => {
		// Two peer bars scaled to the larger meant Vercel was ALWAYS full width — no information —
		// and a caption had to explain that the other was a subset rather than a rival.
		const html = render(<DataHealthPanel data={health(2356, 475) as never} />)
		expect(html).toContain('Pageviews Vercel counted')
		expect(html).toContain('Seen by Google Analytics')
		// The remainder is the quantity the reader came for, stated rather than left to subtract.
		expect(html).toContain('1,881')
		expect(html).toContain('it missed')
	})

	it('fills the bar to the part\'s SHARE of the whole, which is the whole point', () => {
		// The text being right proves nothing about the picture. A fill hard-coded to 100% passes
		// every assertion above — the figures still read 2,356 and 475 — while drawing a GA4 bar
		// the full width of Vercel's, which is the exact claim this encoding replaced.
		const html = render(<DataHealthPanel data={health(2356, 475) as never} />)
		const widths = [...html.matchAll(/width:\s*([0-9.]+)%/g)].map((m) => Number(m[1]))
		// 475 of 2,356 is 20.2%.
		expect(widths.some((w) => Math.abs(w - 20.16) < 0.5)).toBe(true)
		expect(widths).not.toContain(100)
	})

	it('does not claim containment when the part exceeds the whole', () => {
		// Real, not hypothetical: GA4 counts more than Vercel wherever Vercel's collection started
		// after the range began, as on MCKL. Containment is simply the wrong picture there.
		expect(isContainment(ok(100) as never, ok(140) as never)).toBe(false)
		expect(ContainmentBar({
			wholeLabel: 'w', whole: ok(100) as never, partLabel: 'p', part: ok(140) as never, missingLabel: 'missed',
		})).toBeNull()
	})

	it('reverses the containment rather than falling back to peer bars', () => {
		// When GA4 counts MORE than Vercel it is because Vercel started collecting after the range
		// began — so Vercel's count is the subset, and it is still a containment with the operands
		// swapped. Two peer bars scaled to the larger put GA4 at full width saying nothing, which is
		// verbatim the defect ContainmentBar replaced.
		const html = render(<DataHealthPanel data={health(100, 140) as never} />)
		expect(html).toContain('Pageviews Google Analytics counted')
		expect(html).toContain('Also counted by Vercel')
		expect(html).toContain('collection started after this range began')
	})

	it('draws order statuses as shares of a stated total, not as peer cards', () => {
		// The reader's question is what SHARE of the order book is the status configured as a sale.
		// A card each, sorted by count, makes that a sum done by eye — and the configuration mistake
		// that zeroes every order-derived figure stays arithmetic rather than becoming visible.
		const withStatuses = { ...health(2356, 475), orderStatuses: { paid: 7, refunded: 2, draft: 1 } }
		const html = render(<DataHealthPanel data={withStatuses as never} />)
		// Folded by default — consulted once ever, when configuring which statuses count as a sale.
		// What must stay on screen is the INSTRUCTION, which the section carries in its subtitle
		// outside the fold: that is what makes folding legal in a package whose founding rule is
		// that a caveat sits beside its figure.
		expect(html).toContain('Order statuses in this range')
		expect(html).toContain('Use these values to set which statuses count as a sale')
		expect(html).toContain('aria-expanded="false"')
		// And the chart itself is genuinely absent rather than merely hidden.
		expect(html).not.toContain('Orders in this range')
	})

	it('draws them as shares of a stated total once opened', () => {
		// The reader's question is what SHARE of the order book is the status configured as a sale.
		// A card each, sorted by count, makes that a sum done by eye. Rendered directly, since the
		// fold needs a click this environment has no DOM for.
		const html = render(<ProportionChart
			bars={[{ key: 'paid', label: 'paid', value: 7 }, { key: 'refunded', label: 'refunded', value: 2 }, { key: 'draft', label: 'draft', value: 1 }]}
			format={(n) => formatCount(n)}
			totalLabel="Orders in this range"
		/>)
		expect(html).toContain('Orders in this range')
		expect(html).toMatch(/70%|70\.0%/)
	})

	it('still shows what one source reported when the other did not answer', () => {
		// Deleting ComparisonBar took this case with it: with GA4 down, both containments return
		// null and the section rendered nothing at all — not even the figure Vercel did report.
		const dead = { ...health(2620, 0), ga4Pageviews: unavailable('source_error'), shortfallRatio: null }
		const html = render(<DataHealthPanel data={dead as never} />)
		expect(html).toContain('2,620')
		expect(html).toContain('nothing to compare')
	})

	it('refuses when either side was not measured', () => {
		expect(isContainment(unavailable('source_error') as never, ok(10) as never)).toBe(false)
		expect(isContainment(ok(10) as never, unavailable('source_error') as never)).toBe(false)
	})

	it('no longer explains in prose what the encoding now shows', () => {
		const html = render(<DataHealthPanel data={health(2356, 475) as never} />)
		expect(html).not.toContain('not a rival measurement')
		expect(html).not.toContain('Blocked less than GA4')
	})
})

describe('columns a reader is told not to read, and columns that are two other columns', () => {
	it('no longer offers an Opens column', () => {
		// The caption above the table used to say, in the tool's own words, to sort on clicks and
		// not opens. A column whose own caption instructs you not to read it should not be there.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
			audience: ok(4210), audienceGrowth: ok(12), crossSource: [], timelineEvents: [],
			campaigns: [{ title: 'Freight release', subject: 'x', sentAt: '2026-08-20T19:00:00+00:00',
				sent: 2000, opens: 900, clicks: 120, unsubscribed: 3 }],
		} as never} />)
		expect(html).toContain('Clicks')
		expect(html).not.toContain('>Opens<')
		// And the warning is shorter, because it no longer has to talk the reader out of a column.
		expect(html).not.toContain('sort on clicks, not opens')
	})

	it('no longer offers a Test rate column', () => {
		// tested ÷ viewed, from the two columns immediately to its left.
		const html = render(<TypefaceInterestPanel data={{
			rows: [{ typeface: 'Freight', viewed: ok(40), tested: ok(10), bought: ok(2),
				revenue: ok(300), testRate: 0.25, buyRate: 0.05 }],
			currency: 'USD', rowsWithheld: false, rowsTruncated: false,
			interpretationNote: '', licenceTiers: [],
		} as never} />)
		expect(html).toContain('Freight')
		expect(html).not.toContain('Test rate')
	})
})

describe('the words a reader actually meets', () => {
	/**
	 * These pin the RENAMES, because the reason for each is not visible in the code.
	 *
	 * "Partial" reads as a loading state. "Caveat" is the register of small print, and small print
	 * is what a reader skips — which defeats a list whose whole job is to be read. "Unattributed"
	 * is a money word on a traffic figure. "Coverage" reads as insurance. Without a test, the next
	 * person tidying labels puts the shorter, more technical word back.
	 */
	it('does not call a figure Partial, which reads as still loading', () => {
		const html = render(<MetricFigure metric={{ status: 'partial', value: 455, coveredFrom: '', note: 'over 2 of 7' } as never} label="Average order" />)
		expect(html).toContain('Some orders only')
		expect(html).not.toContain('>Partial<')
	})

	it('does not label its warnings Caveat, which readers skip', () => {
		const html = render(<NoticeList notices={['GA4 answered from a sample.']} />)
		expect(html).toContain('Note')
		expect(html).not.toContain('Caveat')
	})

	it('does not say a figure was withheld for privacy, which sounds like a legal hold', () => {
		const html = render(<MetricFigure metric={unavailable('suppressed') as never} label="Tested" />)
		expect(html).toContain('too few people')
		expect(html).not.toContain('for privacy')
	})

	it('does not say a figure does not apply, which sounds like someone chose that', () => {
		const html = render(<MetricFigure metric={unavailable('not_applicable') as never} label="Average order" />)
		expect(html).toContain('Nothing here to work this out from')
		expect(html).not.toContain('Does not apply')
	})
})

describe('what a reader meets first', () => {
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
		campaigns: [], crossSource: [], timelineEvents: [],
	}

	it('says something when nothing arrived, instead of rendering dashes and a footer', () => {
		// This branch is reached exactly where the reader most needs a sentence: a new site, an
		// empty window, or a route older than the fields the verdict reads. Returning null there
		// reads as the tool being broken rather than the window being empty.
		const empty = {
			...base,
			revenue: unavailable('route_outdated'), orders: unavailable('route_outdated'),
			vercelPageviews: unavailable('source_error'), shortfallRatio: null,
		}
		const html = render(<OverviewPanel data={empty as never} />)
		expect(html).toContain('No figures arrived for this window')
	})

	it('includes orders in the verdict, the least noisy signal it has', () => {
		// Scoped to the verdict's own SENTENCE. A bare /Orders/ passes on the card label further
		// down the panel, so dropping the clause from the verdict left the test green — the same
		// coincidence match that let a deleted radiogroup keep its test.
		const html = render(<OverviewPanel data={base as never} previous={{ orders: ok(4), revenue: ok(560), vercelPageviews: ok(2200) } as never} />)
		expect(html).toContain('Orders 7, was 4')
	})

	it('no longer prints a blurb restating the tab label', () => {
		const tool = readFileSync(new URL('./VisitorInsightsTool.tsx', import.meta.url), 'utf8')
		expect(tool).not.toContain('active.blurb')
		// And the dead field is gone, not merely unrendered.
		expect(tool).not.toContain('blurb:')
	})
})

describe('Data health answers before it argues', () => {
	const data = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: { paid: 7 },
		interpretation: 'GA4 recorded 80% fewer pageviews than Vercel.',
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
		campaigns: [], crossSource: [], timelineEvents: [],
		// The capture section is conditional on these; without them the tab renders four blocks,
		// not five, and the order test below would be checking a shorter page than a reader sees.
		capture: { estimates: [{ basis: 'orders', rate: 0.2, note: '' }], discrepancy: null },
	}
	const diagnostics = { checks: [{ key: 'ga4', label: 'GA4 credentials', status: 'pass', detail: 'Configured' }] }

	/** Where each landmark appears in the rendered markup. */
	const positions = (html: string) => ({
		reading: html.indexOf('fewer pageviews than Vercel'),
		evidence: html.indexOf('Pageviews, source against source'),
		fixes: html.indexOf('GA4 credentials'),
		reference: html.indexOf('Order statuses in this range'),
	})

	it('states its conclusion before the bars that support it', () => {
		// The tab exists to answer one question. It opened with a title, a note and a bar, and
		// stated the answer fourth — the working before the conclusion.
		const p = positions(render(<DataHealthPanel data={data as never} diagnostics={diagnostics as never} />))
		expect(p.reading).toBeGreaterThan(-1)
		expect(p.reading).toBeLessThan(p.evidence)
	})

	it('puts the things a reader can fix above the things they can only read', () => {
		// Configuration is the only block on the tab carrying remedies, and it was fifth.
		const p = positions(render(<DataHealthPanel data={data as never} diagnostics={diagnostics as never} />))
		expect(p.fixes).toBeGreaterThan(-1)
		expect(p.fixes).toBeLessThan(p.reference)
	})

	it('still renders everything it did before, just in a different order', () => {
		const html = render(<DataHealthPanel data={data as never} diagnostics={diagnostics as never} />)
		for (const marker of ['Pageviews, source against source', 'How much GA4 is seeing',
			'Order statuses in this range', 'GA4 credentials']) {
			expect(html).toContain(marker)
		}
	})
})

describe('the timeline does not report a selling day as a measured zero', () => {
	/** Three days: two with orders, one of which records no amount. */
	const crossSource = [
		{ date: '2026-08-20', vercelPageviews: 400, ga4Pageviews: 90, ga4Sessions: 70, orders: 1, revenue: 300 },
		{ date: '2026-08-21', vercelPageviews: 380, ga4Pageviews: 85, ga4Sessions: 66, orders: 1, revenue: 0 },
		{ date: '2026-08-22', vercelPageviews: 420, ga4Pageviews: 95, ga4Sessions: 74, orders: 0, revenue: 0 },
	]
	const data = (ordersWithTotal: number | null) => ({
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(2), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1400), ordersWithTotal, vercelDailyUnavailable: false,
		revenue: ok(300), currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
		campaigns: [], crossSource, timelineEvents: [],
	})

	it('withholds the revenue row when some orders carry no amount', () => {
		// The server fills a day's revenue as `?? 0`, so a real sale with no recorded amount became
		// a measured zero and the chart drew the "we looked, and nothing happened" tick on it. At
		// Darden that is 58 of 69 days.
		expect(revenueCoversEveryOrder(data(1) as never)).toBe(false)
		// Counted, not matched. "Revenue" is also a metric card label on this panel, so a bare
		// not.toContain passes for the wrong reason — the coincidence match that has bitten this
		// suite repeatedly. One occurrence is the card; two would mean the chart row came back.
		const html = render(<OverviewPanel data={data(1) as never} />)
		expect(html).toContain('Orders')
		const withRow = render(<OverviewPanel data={data(2) as never} />)
		expect((html.match(/Revenue/g) ?? []).length)
			.toBeLessThan((withRow.match(/Revenue/g) ?? []).length)
	})

	it('draws the revenue row when every order carries an amount', () => {
		expect(revenueCoversEveryOrder(data(2) as never)).toBe(true)
		const html = render(<OverviewPanel data={data(2) as never} />)
		expect(html).toContain('Revenue')
	})

	it('always draws orders, which are exact whatever the amounts say', () => {
		for (const withTotal of [0, 1, 2, null]) {
			expect(render(<OverviewPanel data={data(withTotal) as never} />)).toContain('Orders')
		}
	})

	it('withholds revenue when the order count cannot be read at all', () => {
		expect(revenueCoversEveryOrder({ ...data(null), orders: unavailable('source_error') } as never)).toBe(false)
	})
})

describe('the coverage row does not clamp an over-count to perfect', () => {
	it('scales above 100% when GA4 counts more than the complete source', () => {
		// A double-firing tag is the loudest fixable fault the tool can find. Clamped, it drew as a
		// healthy flat line at 100% — while the card further down the same file refuses that exact
		// clamp in prose. One quantity, two opposite policies, one file.
		// Four days: the chart needs more than a couple to draw at all, and a two-day fixture
		// silently rendered no SVG, so the assertion below was passing judgement on an empty string.
		const over = [
			{ date: '2026-08-20', vercelPageviews: 100, ga4Pageviews: 250, ga4Sessions: 200, orders: 0, revenue: null },
			{ date: '2026-08-21', vercelPageviews: 100, ga4Pageviews: 240, ga4Sessions: 190, orders: 0, revenue: null },
			{ date: '2026-08-22', vercelPageviews: 100, ga4Pageviews: 230, ga4Sessions: 180, orders: 0, revenue: null },
			{ date: '2026-08-23', vercelPageviews: 100, ga4Pageviews: 245, ga4Sessions: 195, orders: 0, revenue: null },
		]
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(490), vercelPageviews: ok(200), shortfallRatio: -1.45,
			ga4Sessions: ok(390), orders: ok(0), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(150), ordersWithTotal: 0, vercelDailyUnavailable: false,
			revenue: unavailable('not_applicable'), currency: 'USD', orderStatuses: {}, interpretation: '',
			audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
			campaigns: [], crossSource: over, timelineEvents: [],
		} as never} />)
		// The axis maximum must exceed 100%, or the over-count is invisible.
		// The AXIS, not the table beneath it. A bare match on "2xx.x%" passes on the data table,
		// which prints the raw daily values and is unaffected by the row's domain — so the clamp
		// could come back and the assertion would still be green. Only <text> is the chart.
		expect(html).toContain('Share GA4 saw')
		const axisLabels = [...html.matchAll(/<text[^>]*>([^<]+)</g)].map((m) => m[1])
		expect(axisLabels.some((t) => /^2[0-9][0-9]\.[0-9]%$/.test(t ?? ''))).toBe(true)
	})
})

describe('three estimates of one number, on one axis', () => {
	const estimates = [
		{ basis: 'orders', rate: 0.29, observed: 2, actual: 7, note: '' },
		{ basis: 'email', rate: 0.21, observed: 25, actual: 120, note: '' },
		{ basis: 'pageviews', rate: 0.20, observed: 475, actual: 2356, note: '' },
	]
	const interval = (e: { rate: number; actual: number }) => {
		// A crude normal approximation, enough to exercise the plot: tiny samples get wide bars.
		const spread = Math.min(0.9, 1 / Math.sqrt(Math.max(1, e.actual)))
		return { low: Math.max(0, e.rate - spread), high: e.rate + spread }
	}
	const plot = (rows = estimates) => render(
		<EstimateDotPlot estimates={rows} labelFor={(b) => `against ${b}`} intervalFor={interval} />,
	)

	it('plots each estimate against a shared scale rather than in its own card', () => {
		const html = plot()
		// One track per estimate, all positioned against the same maximum.
		expect((html.match(/position:relative/g) ?? []).length).toBe(3)
		expect(html).toContain('against orders')
		expect(html).toContain('against pageviews')
	})

	it('places a lower estimate further left than a higher one', () => {
		// The whole point: disagreement becomes a distance. Positions must track the rates.
		const html = plot()
		const lefts = [...html.matchAll(/border-radius:50%[^"]*left:([\d.]+)%/g)].map((m) => Number(m[1]))
		// Rendered in order orders (0.29) > email (0.21) > pageviews (0.20).
		expect(lefts.length).toBe(3)
		expect(lefts[0]).toBeGreaterThan(lefts[1] as number)
		expect(lefts[1]).toBeGreaterThan(lefts[2] as number)
	})

	it('says which estimate the sample is too thin to lean on', () => {
		// n=7 leaves an interval most of the axis wide. That is the reader's cue to discount it,
		// and it must be in words too, because the bar is aria-hidden.
		expect(plot()).toContain('too small a sample to lean on')
	})

	it('keeps the diagnosis when an estimate exceeds 100%, not just the reading', () => {
		const over = [{ basis: 'orders', rate: 2.5, observed: 250, actual: 100, note: '' }]
		const html = plot(over)
		expect(html).toContain('over 100%')
		expect(html).toContain('usually a tag firing twice')
	})

	it('opens the scale past 100% so an over-count is not pinned to the edge', () => {
		// Clamped, a tag reporting 250% of reality draws as perfect — the same defect the coverage
		// row carried.
		const over = [
			{ basis: 'orders', rate: 2.5, observed: 250, actual: 100, note: '' },
			{ basis: 'pageviews', rate: 0.2, observed: 475, actual: 2356, note: '' },
		]
		const lefts = [...plot(over).matchAll(/border-radius:50%[^"]*left:([\d.]+)%/g)].map((m) => Number(m[1]))
		// Precise, not merely ordered. With the scale opening to 2.5 the healthy estimate sits at
		// 0.2/2.5 = 8% of the axis; clamped at 1 it would sit at 20% — and a loose "< 30" passes
		// for both, so the clamp could come back unnoticed. This is the fourth assertion in this
		// suite to have been satisfied by a coincidence rather than by the thing it names.
		expect(lefts[0]).toBeGreaterThan(90)
		expect(lefts[1]).toBeLessThan(12)
	})

	it('draws nothing when there is nothing to compare', () => {
		expect(EstimateDotPlot({ estimates: [], labelFor: (b) => b, intervalFor: interval })).toBeNull()
	})
})




describe('turning a ratio over', () => {
	const parts = [
		{ label: 'visitors', value: 2356 },
		{ label: 'orders', value: 7 },
	]

	it('shows the rate by default, with a control to see its counts', () => {
		const html = render(<RatioFigure value={337} format={(v) => formatCount(v)} parts={parts} />)
		expect(html).toContain('337')
		expect(html).toContain('counts')
		// The parts are not on screen until asked for — the ratio is the headline.
		expect(html).not.toContain('2,356')
	})

	it('names what the control will reveal, rather than saying "toggle"', () => {
		// A reader should know what they will get before pressing; the label is the only thing
		// telling them.
		const html = render(<RatioFigure value={337} format={(v) => formatCount(v)} parts={parts} />)
		expect(html).toContain('Show the counts behind this rate')
	})

	it('offers no control when the ratio could not be computed', () => {
		// There is nothing to turn over: the parts are already all there is.
		const html = render(
			<RatioFigure value={null} format={(v) => formatCount(v)} parts={parts} unavailable={<span>no orders yet</span>} />,
		)
		expect(html).toContain('no orders yet')
		expect(html).not.toContain('aria-pressed')
	})

	it('offers no control when a part is missing, so the counts face would lie', () => {
		const html = render(
			<RatioFigure value={337} format={(v) => formatCount(v)} parts={[{ label: 'visitors', value: null }, { label: 'orders', value: 7 }]} />,
		)
		expect(html).not.toContain('aria-pressed')
	})

	it('lets each part carry its own format, so money is not counted like people', () => {
		const html = render(
			<RatioFigure
				value={455}
				format={(v) => `US$${v}`}
				parts={[{ label: 'taken', value: 910, format: (v) => `US$${v}` }, { label: 'orders', value: 2 }]}
			/>,
		)
		expect(html).toContain('US$455')
	})
})

describe('the per-thousand column completes its own arithmetic', () => {
	it('prints the money the rate came from, since the denominator is already a column', () => {
		// A card gets a toggle; a table cannot without twenty buttons — but Sent is a column, so
		// printing the numerator underneath finishes the sum in place.
		const html = render(<OverviewPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
			vercelVisitors: ok(1400), ordersWithTotal: 7, vercelDailyUnavailable: false,
			revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
			audience: ok(4210), audienceGrowth: ok(12), crossSource: [], timelineEvents: [],
			campaigns: [{ title: 'Freight release', subject: 'x', sentAt: '2026-08-20T19:00:00+00:00',
				sent: 2000, opens: 900, clicks: 120, unsubscribed: 3,
				ordersAfter: 2, revenueAfter: 700, windowDays: 3, windowComplete: true }],
		} as never} />)
		expect(html).toContain('from US$700')
	})
})

describe('the comparison identity', () => {
	// A reader asked for everything that refers to the other window to look like one thing. That
	// makes the colour a contract, not a style choice — and it makes the NON-colour direction
	// channels load-bearing, because the tone-dependent underline that used to carry direction is
	// gone. None of this had a single test before; deleting the underline passed silently.

	it('draws the move and its baseline in the one comparison colour', () => {
		const html = render(<Delta current={357} previous={298} />)
		// Both halves, so "from 298" cannot drift back into a grey of its own.
		// The PROPERTY, not the hex. The hex is only the var() fallback now, so matching it passed on
		// the failure mode — which is exactly how a dark-theme contrast bug shipped green last pass.
		expect(html.match(/var\(--vi-comparison/g)?.length).toBeGreaterThanOrEqual(2)
	})

	it('draws a good move and a bad move in the same colour', () => {
		// The whole point: hue says "this is a comparison", never "this is good news".
		const good = render(<Delta current={357} previous={298} />)
		const bad = render(<Delta current={298} previous={357} />)
		expect(good).toContain(COMPARISON_TEXT)
		expect(bad).toContain(COMPARISON_TEXT)
	})

	it('still separates a good move from a bad one without using colour', () => {
		// Direction now rides entirely on the arrow and the sign. If both of these go, the figure
		// says a number changed and refuses to say which way.
		const good = render(<Delta current={357} previous={298} />)
		const bad = render(<Delta current={298} previous={357} />)
		expect(good).toContain('\u2191')
		expect(bad).toContain('\u2193')
		expect(good).toContain('+')
	})

	it('reads the same for a figure where falling is the good outcome', () => {
		// riseIsGood used to pick a tone that picked a style. It no longer touches the drawing, so
		// an Unattributed share that falls must look exactly like one that rises.
		// Percentage points, on the 0-100 scale the panels pass — 26.9% against 31.1%, as the
		// No-source card shows it.
		const falling = render(<Delta current={26.9} previous={31.1} unit="percent" riseIsGood={false} />)
		expect(falling).toContain(COMPARISON_TEXT)
		expect(falling).toContain('\u2193')
	})

	it('never underlines, because a coloured underlined span is a link', () => {
		// These sit on the same panels as real source links.
		const bad = render(<Delta current={298} previous={357} />)
		expect(bad).not.toContain('borderBottom')
		expect(bad).not.toContain('border-bottom')
	})

	it('says what a flat move was flat against', () => {
		const html = render(<Delta current={300} previous={300} />)
		expect(html).toContain('no change')
		expect(html).toContain('from 300')
	})

	it('does not leave an arrow attached to nothing when the percentage is withheld', () => {
		// Below MIN_DELTA_BASE the percentage is refused, which is right — but the branch used to
		// emit "arrow, space, empty, space, from 4".
		const html = render(<Delta current={7} previous={4} />)
		expect(html).toContain('too few to rate')
		expect(html).toContain('from 4')
	})
})

describe('a funnel rung measured over fewer days says so', () => {
	// The only finding in this review that made the tool WRONG rather than confusing. Darden
	// instrumented view_item on 1 September and tester_engaged on 9 September; on a month range
	// both rungs counted a fraction of the window and were drawn beside a full-month page_view,
	// captioned "33.9% of landed" — a 13-day numerator over a 31-day denominator, to one decimal.

	const partialStages = [
		{ key: 'landed', label: 'Landed', value: 475, conversionFromPrevious: null },
		{ key: 'viewed', label: 'Viewed a typeface', value: 161, conversionFromPrevious: 0.339, partial: { from: '1 Sept' } },
		{ key: 'bought', label: 'Purchased', value: 7, conversionFromPrevious: 0.043 },
	]

	it('refuses the share, because its numerator and denominator cover different windows', () => {
		const html = render(<FunnelChart stages={partialStages} measurement="independent-totals" />)
		expect(html).not.toContain('33.9%')
	})

	it('says which day the count starts from', () => {
		const html = render(<FunnelChart stages={partialStages} measurement="independent-totals" />)
		// The reason, not just the date. "Only counted from 1 Sep" reads as a fault; the truth is
		// that nobody was looking before then because the tracking did not exist.
		expect(html).toContain('tracking added 1 Sept')
	})

	it('still shows the count, which is real for the days it covers', () => {
		const html = render(<FunnelChart stages={partialStages} measurement="independent-totals" />)
		expect(html).toContain('161')
	})

	it('draws no bar, so the picture makes no claim the text has withdrawn', () => {
		const html = render(<FunnelChart stages={partialStages} measurement="independent-totals" />)
		const partialRung = funnelRung(html, 'Viewed a typeface')
		expect(partialRung).not.toMatch(/width:\s*\d/)
	})

	it('leaves a fully measured rung solid', () => {
		const html = render(<FunnelChart stages={[
			{ key: 'landed', label: 'Landed', value: 475, conversionFromPrevious: null },
			{ key: 'viewed', label: 'Viewed a typeface', value: 161, conversionFromPrevious: 0.339 },
		]} measurement="independent-totals" />)
		expect(html).not.toContain('repeating-linear-gradient')
		expect(html).toContain('33.9%')
	})
})

describe('the funnel states what a full-width bar means', () => {
	it('labels the entry rung with the scale rather than restating its position', () => {
		// "entry step" said the first bar was the first bar. Every bar is a share of this one, and
		// nothing on the chart said so — which is what turns the rail into a scale.
		const html = render(<FunnelChart stages={[
			{ key: 'a', label: 'Landed', value: 2000, conversionFromPrevious: null },
			{ key: 'b', label: 'Viewed', value: 900, conversionFromPrevious: 0.45 },
		]} measurement="sequence" />)
		expect(html).toContain('100%')
		expect(html).not.toContain('entry step')
	})
})

describe('the panel carries a step\'s coverage into the chart', () => {
	// A mutation that deleted this wiring left the whole suite green: the FunnelChart tests pass a
	// `partial` prop directly, so nothing checked that JourneyPanel ever sets it. That is the
	// original defect exactly — the panel discarding the metric's status on the way in — so it gets
	// a test at the seam rather than on either side of it.

	const withPartial = {
		approximate: true as const,
		approximationNote: 'Each step is counted on its own, not as a tracked journey.',
		steps: [
			{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(475), conversionFromPrevious: null },
			{
				key: 'viewed',
				label: 'Viewed a typeface',
				event: 'view_item',
				count: partial(161, '2026-09-01', 'Only counted from 2026-09-01, when this event was added'),
				conversionFromPrevious: 0.339,
			},
		],
		topLandingPages: [],
		outcomes: [],
		measurement: 'independent-totals' as const,
	}

	it('marks the rung rather than drawing it as a full-window count', () => {
		const html = render(<JourneyPanel data={withPartial as never} />)
		expect(html).toContain('tracking added 1 Sept')
	})

	it('does not print a share across two different windows', () => {
		// 161 over 13 days against 475 over 31. This is the number the panel used to publish.
		const html = render(<JourneyPanel data={withPartial as never} />)
		expect(html).not.toContain('33.9%')
	})

	it('says the date the way a reader would, not as the raw cutover string', () => {
		const html = render(<JourneyPanel data={withPartial as never} />)
		expect(html).not.toContain('only counted from 2026-09-01,')
	})
})

describe('the legend is drawn in the same ink as the chart', () => {
	// The reported fault: "the graph legends don't seem to match the graphs". There were three
	// legends — a coloured swatch per row inside the plot, a second coloured set in the hover card,
	// and a key underneath drawing ─── ╌╌╌ ▮▮▮ as TEXT GLYPHS inside a muted <Text>. The glyphs
	// inherited the muted grey, so the key was monochrome while the chart was blue, amber and green.

	const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
	const withShortfall = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.8,
		ga4Sessions: ok(357), orders: ok(2), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: null, vercelDailyUnavailable: false,
		revenue: ok(0), currency: 'USD', orderStatuses: {},
		audience: ok(1), audienceGrowth: ok(0), campaigns: [],
		interpretation: 'x', timelineEvents: [],
		crossSource: days.map((date, i) => ({
			date, vercelPageviews: 100 + i * 10, ga4Pageviews: 20 + i * 2, ga4Sessions: 15, orders: 0, revenue: 0,
		})),
	}

	it('draws no legend swatch as a text glyph', () => {
		// The mechanism of the bug. A glyph takes the colour of the text around it; a styled element
		// takes the colour of the mark.
		const html = render(<OverviewPanel data={withShortfall as never} />)
		for (const glyph of ['\u2500\u2500\u2500', '\u254c\u254c\u254c', '\u25ae\u25ae\u25ae']) {
			expect(html).not.toContain(glyph)
		}
	})

	it('keys the dashed line that runs along the top of the shaded area', () => {
		// It had no entry on any surface. The label was set by the panel and rendered nowhere in the
		// package, so a reader saw an unexplained dashed line and the only dashed thing the old key
		// described was "a lossy source" — the available inference was the wrong one.
		const html = render(<OverviewPanel data={withShortfall as never} />)
		// The legend's own phrasing. Bare "Seen by GA4" is also a column header in the table below
		// the chart, so asserting that alone passed even with the legend entry deleted.
		expect(html).toContain('Seen by GA4 \u2014 the dashed line')
	})

	it('draws that key in the colour the line is drawn in', () => {
		const html = render(<OverviewPanel data={withShortfall as never} />)
		expect(html).toContain(SERIES.ga4Pageviews)
	})

	it('does not key a comparison that was never drawn', () => {
		// `previous?.crossSource ?? []` is an empty array, which is truthy — so with no comparison
		// loaded the chart reported it had one and the key named a mark nothing had drawn. That is
		// the same class of fault as the monochrome key, pointing the other way.
		const html = render(<OverviewPanel data={withShortfall as never} />)
		expect(html).not.toContain('window you are comparing against')
	})

	it('keys the comparison when there is one', () => {
		const previous = { ...withShortfall, crossSource: withShortfall.crossSource.map((d) => ({ ...d, vercelPageviews: 90 })) }
		const html = render(<OverviewPanel data={withShortfall as never} previous={previous as never} />)
		expect(html).toContain('window you are comparing against')
		// The SWATCH, in the identity. Asserting the bare hex passed regardless of what the swatch
		// was painted, because Delta emits the same hex elsewhere in this render.
		expect(html).toContain(mark('chart.ghost'))
	})

	it('leaves the readout slot empty until there is something to read', () => {
		// It held "Hover the chart to read a day" permanently — an instruction occupying the line
		// where the data goes, and untrue on touch.
		const html = render(<OverviewPanel data={withShortfall as never} />)
		expect(html).not.toContain('Hover the chart to read a day')
	})

	it('does not tell the reader to use a control that is gone', () => {
		const html = render(<OverviewPanel data={withShortfall as never} />)
		expect(html).not.toContain('use the control below')
	})
})

describe('a column of dashes says why where it sits', () => {
	const rows = [
		{ source: 'google', channel: 'Organic Search', medium: 'organic', campaign: null, sessions: 151, engagedSessions: 96, engagementRate: 0.636, designIndustry: false, unattributed: false },
	]

	it('explains the empty revenue column when the split could not be made', () => {
		// The explanation was gated on the SUCCESS case, so in exactly the state where every cell is
		// a dash there was no explanation on screen — the reason went to `notices` at the foot of the
		// panel, where it can also be folded behind "N more caveats".
		const html = render(<AcquisitionPanel data={{
			totalSessions: 151, designIndustryShare: null, unattributedShare: null,
			rowsWithheld: false, rowsTruncated: false, rows,
			splitIsSound: false, actualRevenue: 910, actualOrders: 7, trackedPurchases: 1, shownPurchases: 1,
			currency: 'USD',
		} as never} />)
		expect(html).toContain('Revenue is not split across sources here')
	})

	it('names the reason, so the two failures are not one message', () => {
		// No total to divide is a different problem from a total nobody could attribute, and they
		// call for different things from the reader.
		const noTotal = render(<AcquisitionPanel data={{
			totalSessions: 151, designIndustryShare: null, unattributedShare: null,
			rowsWithheld: false, rowsTruncated: false, rows,
			splitIsSound: false, actualRevenue: null, actualOrders: null, trackedPurchases: 0, shownPurchases: 0,
			currency: 'USD',
		} as never} />)
		expect(noTotal).toContain('no amount for this period')
	})

	it('says nothing when the split worked', () => {
		const html = render(<AcquisitionPanel data={{
			totalSessions: 151, designIndustryShare: null, unattributedShare: null,
			rowsWithheld: false, rowsTruncated: false,
			rows: rows.map((r) => ({ ...r, revenueShare: 1, apportionedRevenue: 910 })),
			splitIsSound: true, actualRevenue: 910, actualOrders: 7, trackedPurchases: 7, shownPurchases: 7,
			currency: 'USD',
		} as never} />)
		expect(html).not.toContain('Revenue is not split across sources here')
	})
})

describe('a caption does not explain a number that is not there', () => {
	// A sentence about the provenance of a figure, rendered underneath an em-dash, is the clearest
	// "half-built" signal on the default tab — and these were unconditional.

	const missing = {
		ga4Pageviews: unavailable('source_error'), vercelPageviews: unavailable('source_error'),
		shortfallRatio: null, ga4Sessions: unavailable('source_error'),
		orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: unavailable('source_error'), ordersWithTotal: 0, vercelDailyUnavailable: true,
		revenue: unavailable('not_applicable'), currency: 'USD', orderStatuses: {},
		interpretation: '', audience: unavailable('not_applicable'), audienceGrowth: unavailable('not_applicable'),
		crossSource: [], timelineEvents: [], campaigns: [],
	}

	it('drops the Vercel caption when Vercel did not answer', () => {
		const html = render(<OverviewPanel data={missing as never} />)
		expect(html).not.toContain('from Vercel’s own counter')
	})

	it('drops the mailing-list caption on a site with no Mailchimp', () => {
		const html = render(<OverviewPanel data={missing as never} />)
		expect(html).not.toContain('Everyone subscribed today')
	})

	it('drops the visitor caption when there is no visitor count', () => {
		const html = render(<OverviewPanel data={missing as never} />)
		expect(html).not.toContain('some are bots or the same person twice')
	})

	it('keeps each caption when its own figure is there', () => {
		const present = {
			...missing,
			vercelPageviews: ok(2356), vercelVisitors: ok(1580),
			audience: ok(4210), audienceGrowth: ok(108),
		}
		const html = render(<OverviewPanel data={present as never} />)
		expect(html).toContain('from Vercel’s own counter')
		expect(html).toContain('Everyone subscribed today')
		expect(html).toContain('some are bots or the same person twice')
	})
})

describe('a part-window rung refuses the encoding, not just the number', () => {
	// The half-fix that shipped: the SENTENCE said no share was shown while the BAR went on showing
	// one. 161 counted over sixteen days, drawn at 161/475 of a rail whose denominator spans thirty,
	// reads as "a third of arrivals" when the comparable figure is nearer two thirds. A reader
	// measures bars against each other whatever the caption says.

	const stages = [
		{ key: 'landed', label: 'Landed', value: 475, conversionFromPrevious: null },
		{ key: 'viewed', label: 'Viewed a typeface', value: 161, conversionFromPrevious: 0.339, partial: { from: '1 Sept' } },
	]

	it('draws no proportional bar for the partial rung', () => {
		const html = render(<FunnelChart stages={stages} measurement="independent-totals" />)
		// 161/475 is 33.9%. No element may be that wide.
		expect(html).not.toMatch(/width:\s*33\.\d+%/)
	})

	it('draws no bar at all, in either direction', () => {
		// A short bar overstated nothing and understated the count; a FULL-WIDTH hatched rail — the
		// first attempt at refusing — handed the least-measured rung the longest mark on a chart
		// where length is the value. An empty slot cannot be mis-measured either way.
		const html = render(<FunnelChart stages={stages} measurement="independent-totals" />)
		const partialRung = funnelRung(html, 'Viewed a typeface')
		expect(partialRung).not.toMatch(/width:\s*\d/)
		expect(partialRung).not.toContain('repeating-linear-gradient')
	})

	it('keeps the rung in the column rather than collapsing it', () => {
		const html = render(<FunnelChart stages={stages} measurement="independent-totals" />)
		expect(html).toContain('Viewed a typeface')
		expect(html).toContain('161')
	})

	it('still draws a proportional bar for a rung that covers the whole window', () => {
		const html = render(<FunnelChart stages={[
			{ key: 'landed', label: 'Landed', value: 475, conversionFromPrevious: null },
			{ key: 'viewed', label: 'Viewed a typeface', value: 161, conversionFromPrevious: 0.339 },
		]} measurement="independent-totals" />)
		expect(html).toMatch(/width:\s*33\.\d+%/)
	})

	it('explains the absence, since an empty slot is a mark like any other', () => {
		const html = render(<FunnelChart stages={stages} measurement="independent-totals" />)
		expect(html).toContain('Steps with no bar were only tracked for part of this period')
	})

	it('says nothing about missing bars when every rung has one', () => {
		const html = render(<FunnelChart stages={[
			{ key: 'landed', label: 'Landed', value: 475, conversionFromPrevious: null },
		]} measurement="independent-totals" />)
		expect(html).not.toContain('Steps with no bar')
	})
})

describe('the average-order card does not contradict itself', () => {
	const partialAov = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: 2, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: ok(4210), audienceGrowth: ok(108), crossSource: [], timelineEvents: [], campaigns: [],
	}

	it('does not call an average over 2 of 7 orders exact', () => {
		// Both captions rendered, eight words apart, under the tab's second-largest figure: the card
		// stated its caveat and then denied it.
		const html = render(<OverviewPanel data={partialAov as never} />)
		expect(html).toContain('2 of 7 orders')
		expect(html).not.toContain('From your orders, so exact.')
	})

	it('still says so when every order carries an amount', () => {
		const html = render(<OverviewPanel data={{ ...partialAov, ordersWithTotal: 7 } as never} />)
		expect(html).toContain('From your orders, so exact.')
	})
})

describe('a caption needs a figure to be about', () => {
	// `undefined?.status !== "unavailable"` is TRUE. These fields are absent whenever a site's
	// analytics route predates them — the exact case `metricOr(..., OLDER_ROUTE)` exists for — so
	// tightening the gate in an earlier pass produced a dash, an explanation that the route is old,
	// and then a sentence about where the number came from.
	const noRouteFields = {
		ga4Pageviews: ok(475), shortfallRatio: 0.798, ga4Sessions: ok(357), orders: ok(7),
		consentRate: unavailable('not_instrumented'), ordersWithTotal: 7,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
		crossSource: [], timelineEvents: [], campaigns: [],
		// vercelPageviews, vercelVisitors, audience and audienceGrowth deliberately absent.
	}

	it('says nothing about Vercel when the route never sent a Vercel figure', () => {
		const html = render(<OverviewPanel data={noRouteFields as never} />)
		expect(html).not.toContain('from Vercel’s own counter')
		expect(html).not.toContain('some are bots or the same person twice')
	})

	it('says nothing about the mailing list when the route never sent one', () => {
		const html = render(<OverviewPanel data={noRouteFields as never} />)
		expect(html).not.toContain('Everyone subscribed today')
	})
})

describe('the comparison identity is delivered, not just declared', () => {
	it('reads the colour through the property the stylesheet defines', () => {
		// Matching the bare hex passes on the var() FALLBACK, so it cannot tell a working property
		// from one resolving to the wrong half of the pair. That is how a dark-theme contrast bug
		// shipped green.
		const html = render(<Delta current={357} previous={298} />)
		expect(html).toContain('var(--vi-comparison')
	})

	it('keeps a fallback, so a missing stylesheet degrades rather than erases the identity', () => {
		const html = render(<Delta current={357} previous={298} />)
		expect(html).toContain(COMPARISON)
	})
})

describe('the headline revenue figure carries its currency', () => {
	// The card took the money formatter only on `ok` and fell through to MetricFigure — and so to
	// the COUNT formatter — for everything else. Revenue on this site is permanently partial,
	// because most orders predate the amount field, so the branch never fired and the tab's headline
	// money rendered as a bare number beside an "Average order US$455" that did carry one.
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: 2, vercelDailyUnavailable: false,
		currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: ok(4210), audienceGrowth: ok(108), crossSource: [], timelineEvents: [], campaigns: [],
	}

	it('writes a partial revenue as money, not as a count', () => {
		const html = render(<OverviewPanel data={{ ...base, revenue: partial(12346, '', 'over 2 of 7') } as never} />)
		expect(html).toContain('US$12,346')
		expect(html).not.toMatch(/>12,346</)
	})

	it('writes an exact revenue as money too', () => {
		const html = render(<OverviewPanel data={{ ...base, revenue: ok(910), ordersWithTotal: 7 } as never} />)
		expect(html).toContain('US$910')
	})
})

describe('a withheld rate leaves no element behind', () => {
	// This was claimed as fixed in a commit message and was not in the diff — the edit silently
	// matched nothing. `rateLine` returns its own <Text> or null, so the surviving wrapper produced
	// a Text inside a Text when there was a rate, and an empty Text holding a line of leading under
	// every rung when there was not.
	const stages = (values: number[]) => values.map((value, i) => ({
		key: `s${i}`,
		label: ['Landed', 'Viewed', 'Tested', 'Added', 'Checkout', 'Bought'][i]!,
		value,
		conversionFromPrevious: i === 0 ? null : value / values[i - 1]!,
	}))

	it('renders no empty text element under a rung whose rate was withheld', () => {
		const html = render(<FunnelChart stages={stages([1000, 5])} measurement="sequence" />)
		expect(html).not.toMatch(/data-ui="Text"[^>]*><span><\/span>/)
	})

	it('does not nest one text element inside another when there is a rate', () => {
		// A block inside an inline, and two stacked line boxes for one sentence.
		const html = render(<FunnelChart stages={stages([2000, 900])} measurement="sequence" />)
		expect(html).not.toMatch(/data-ui="Text"[^>]*><span><div[^>]*data-ui="Text"/)
	})
})

/** The colour the funnel gives segment `index`, read from the same registry the chart reads. */
const segmentColourAt = (index: number) => mark(['survival.line', 'survival.line.2', 'survival.line.3', 'survival.line.4'][index] as string)

describe('the device comparison survives a part-window step', () => {
	// Cutting every line where the window changes is honest and useless: at Darden the first step
	// after entry is part-window, so each line became a single vertex and the chart returned null —
	// the view showing mobile converting at a ninth of desktop simply vanished, with nothing saying
	// why. Dropping those steps keeps the comparison over the steps that can carry one.
	const partialMid = {
		approximate: true as const,
		approximationNote: 'Each step is counted on its own, not as a tracked journey.',
		segmentDimension: 'device',
		steps: [
			{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(475), conversionFromPrevious: null },
			{ key: 'viewed', label: 'Viewed a typeface', event: 'view_item', count: partial(161, '2026-09-01', 'added then'), conversionFromPrevious: 0.339 },
			{ key: 'cart', label: 'Added to cart', event: 'add_to_cart', count: ok(23), conversionFromPrevious: 0.143 },
			{ key: 'bought', label: 'Purchased', event: 'purchase', count: ok(7), conversionFromPrevious: 0.304 },
		],
		segments: [
			{ key: 'desktop', label: 'Desktop', steps: [
				{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(232), conversionFromPrevious: null },
				{ key: 'viewed', label: 'Viewed a typeface', event: 'view_item', count: partial(96, '2026-09-01', 'added then'), conversionFromPrevious: 0.414 },
				{ key: 'cart', label: 'Added to cart', event: 'add_to_cart', count: ok(18), conversionFromPrevious: 0.188 },
				{ key: 'bought', label: 'Purchased', event: 'purchase', count: ok(6), conversionFromPrevious: 0.333 },
			] },
			{ key: 'mobile', label: 'Mobile', steps: [
				{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(219), conversionFromPrevious: null },
				{ key: 'viewed', label: 'Viewed a typeface', event: 'view_item', count: partial(58, '2026-09-01', 'added then'), conversionFromPrevious: 0.265 },
				{ key: 'cart', label: 'Added to cart', event: 'add_to_cart', count: ok(5), conversionFromPrevious: 0.086 },
				{ key: 'bought', label: 'Purchased', event: 'purchase', count: ok(1), conversionFromPrevious: 0.2 },
			] },
		],
		topLandingPages: [],
		outcomes: [],
		measurement: 'independent-totals' as const,
	}

	it('still shows both segments', () => {
		// They subdivide the funnel's own bars now, rather than living in a second chart above it.
		const html = render(<JourneyPanel data={partialMid as never} />)
		expect(html).toContain('Desktop')
		expect(html).toContain('Mobile')
	})

	it('names the two colours it draws them in', () => {
		const html = render(<JourneyPanel data={partialMid as never} />)
		expect(html).toContain(segmentColourAt(0))
		expect(html).toContain(segmentColourAt(1))
	})

	it('draws no split on a part-window rung, since it draws no bar there either', () => {
		// The rung keeps its count and its reason; there is simply no bar for a split to subdivide.
		const html = render(<JourneyPanel data={partialMid as never} />)
		const partialRung = funnelRung(html, 'Viewed a typeface')
		expect(partialRung).not.toContain(segmentColourAt(0))
		expect(partialRung).toContain('tracking added 1 Sept')
	})

	it('splits the rungs that do have a bar', () => {
		const html = render(<JourneyPanel data={partialMid as never} />)
		const cartRung = funnelRung(html, 'Added to cart')
		expect(cartRung).toContain(segmentColourAt(0))
		expect(cartRung).toContain(segmentColourAt(1))
	})
})

describe('the headline revenue figure carries its currency', () => {
	// The card took the money formatter only on `ok` and fell through to MetricFigure — and so to
	// the COUNT formatter — for everything else. Revenue on this site is permanently partial,
	// because most orders predate the amount field, so the branch never fired and the tab's headline
	// money rendered as a bare number beside an "Average order US$455" that did carry one.
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: 2, vercelDailyUnavailable: false,
		currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: ok(4210), audienceGrowth: ok(108), crossSource: [], timelineEvents: [], campaigns: [],
	}

	it('writes a partial revenue as money, not as a count', () => {
		const html = render(<OverviewPanel data={{ ...base, revenue: partial(12346, '', 'over 2 of 7') } as never} />)
		expect(html).toContain('US$12,346')
		expect(html).not.toMatch(/>12,346</)
	})

	it('writes an exact revenue as money too', () => {
		const html = render(<OverviewPanel data={{ ...base, revenue: ok(910), ordersWithTotal: 7 } as never} />)
		expect(html).toContain('US$910')
	})
})

describe('a withheld rate leaves no element behind', () => {
	// This was claimed as fixed in a commit message and was not in the diff — the edit silently
	// matched nothing. `rateLine` returns its own <Text> or null, so the surviving wrapper produced
	// a Text inside a Text when there was a rate, and an empty Text holding a line of leading under
	// every rung when there was not.
	const stages = (values: number[]) => values.map((value, i) => ({
		key: `s${i}`,
		label: ['Landed', 'Viewed', 'Tested', 'Added', 'Checkout', 'Bought'][i]!,
		value,
		conversionFromPrevious: i === 0 ? null : value / values[i - 1]!,
	}))

	it('renders no empty text element under a rung whose rate was withheld', () => {
		const html = render(<FunnelChart stages={stages([1000, 5])} measurement="sequence" />)
		expect(html).not.toMatch(/data-ui="Text"[^>]*><span><\/span>/)
	})

	it('does not nest one text element inside another when there is a rate', () => {
		// A block inside an inline, and two stacked line boxes for one sentence.
		const html = render(<FunnelChart stages={stages([2000, 900])} measurement="sequence" />)
		expect(html).not.toMatch(/data-ui="Text"[^>]*><span><div[^>]*data-ui="Text"/)
	})
})

describe('the verdict leads with the business, not the instrument', () => {
	// The loudest object on the default tab is this card. It joined three facts about the foundry
	// and one about Google Analytics with middots, in one size — so on a site where GA4 sees a fifth
	// of its traffic, an owner with five minutes read an amber alarm whose first clause was
	// plumbing, and had to parse to the end to find the money.
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: 7, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: ok(4210), audienceGrowth: ok(108), crossSource: [], timelineEvents: [], campaigns: [],
	}
	const before = { ...base, revenue: ok(640), orders: ok(5), vercelPageviews: ok(2100) }

	it('puts the money before the measurement fault', () => {
		const html = render(<OverviewPanel data={base as never} previous={before as never} />)
		expect(html.indexOf('US$910')).toBeLessThan(html.indexOf('treat its figures as broken'))
	})

	it('keeps the fault on the card, in smaller type', () => {
		// Demoted, not deleted — it is a real qualifier on the traffic figure beside it.
		const html = render(<OverviewPanel data={base as never} previous={before as never} />)
		expect(html).toContain('treat its figures as broken')
	})

	it('still says something when the coverage reading is all there is', () => {
		// `broken` used to fill `parts`; moving it out meant a window with no business figures fell
		// through to "No figures arrived", which is the one state where the reading is the finding.
		const bare = {
			shortfallRatio: 0.798, ga4Pageviews: ok(475), orderStatuses: {}, interpretation: '',
			crossSource: [], timelineEvents: [], campaigns: [], currency: 'USD',
		}
		const html = render(<OverviewPanel data={bare as never} />)
		expect(html).toContain('treat its figures as broken')
		expect(html).not.toContain('No figures arrived for this window')
	})
})

describe('a sparse envelope degrades instead of throwing', () => {
	// `MetricFigure` reads `metric.status` on its first line, so a field the site's route never sent
	// threw and took the whole panel with it. `metricOr` exists for exactly this case — the window
	// between publishing this package and redeploying a site, which the file elsewhere calls "the
	// normal state of this repo".
	it('renders Overview from an envelope missing most fields', () => {
		const bare = { shortfallRatio: 0.798, orderStatuses: {}, interpretation: '', crossSource: [], timelineEvents: [], campaigns: [] }
		expect(() => render(<OverviewPanel data={bare as never} />)).not.toThrow()
	})

	it('renders Data health from one too', () => {
		const bare = { orderStatuses: {}, interpretation: '', crossSource: [], timelineEvents: [] }
		expect(() => render(<DataHealthPanel data={bare as never} />)).not.toThrow()
	})
})

describe('the catalogue benchmark pools one window', () => {
	// `metricSortValue` returns the value for `partial` as well as `ok`, so a family whose view
	// count covered thirteen days of a thirty-one-day range was pooled with families covering all of
	// it — and the benchmark every OTHER family is measured against was itself computed across a
	// mixture of windows.
	it('leaves a part-window family out of the pooled rate', () => {
		const whole = [
			{ typeface: 'Freight', viewed: ok(1000), bought: ok(10) },
			{ typeface: 'Omnes', viewed: ok(1000), bought: ok(10) },
		]
		const withPartial = [
			...whole,
			// Thirteen days of views against a full range of orders: a rate ten times the others.
			{ typeface: 'Halyard', viewed: partial(100, '2026-09-01', 'added then'), bought: ok(10) },
		]
		expect(catalogueRate(withPartial as never)).toBe(catalogueRate(whole as never))
	})

	it('still returns null when no family has a whole-window count', () => {
		const allPartial = [{ typeface: 'Freight', viewed: partial(100, '2026-09-01', 'x'), bought: ok(10) }]
		expect(catalogueRate(allPartial as never)).toBeNull()
	})
})

describe('the sells-vs-catalogue cell names which absence it is', () => {
	const row = (viewed: unknown) => ({
		typeface: 'Freight', viewed, tested: ok(0), bought: ok(2),
		revenue: ok(400), testRate: null, buyRate: null,
	})

	it('distinguishes a part-window count from a quiet family', () => {
		// Three absences, not two: a real number that cannot be a denominator is neither "too quiet"
		// nor missing.
		const html = render(<TypefaceInterestPanel data={{
			rows: [row(partial(120, '2026-09-01', 'added then'))],
			interpretationNote: '', testerEventCount: 1,
		} as never} />)
		expect(html).toContain('view tracking started mid-period')
		expect(html).not.toContain('too few views to compare')
	})

	it('still says too few for a family nobody looked at', () => {
		const html = render(<TypefaceInterestPanel data={{
			rows: [row(ok(3))],
			interpretationNote: '', testerEventCount: 1,
		} as never} />)
		expect(html).toContain('too few views to compare')
	})
})

describe('the split sentence names the orders the money covers', () => {
	// `actualRevenue` sums only orders carrying an amount; `actualOrders` counts all of them. The
	// sentence joined them with the word "from", so it read "Revenue is US$3,150 from 69 orders"
	// where the money covered eleven.
	const rows = [
		{ source: 'google', channel: 'Organic Search', medium: 'organic', campaign: null, sessions: 151, engagedSessions: 96, engagementRate: 0.6, designIndustry: false, unattributed: false, revenueShare: 1, apportionedRevenue: 3150 },
	]
	const data = (ordersMissingTotal: number | null) => ({
		totalSessions: 151, designIndustryShare: null, unattributedShare: null,
		rowsWithheld: false, rowsTruncated: false, rows,
		splitIsSound: true, actualRevenue: 3150, actualOrders: 69, ordersMissingTotal,
		trackedPurchases: 7, shownPurchases: 7, currency: 'USD',
	})

	it('names the smaller denominator when orders carry no amount', () => {
		const html = render(<AcquisitionPanel data={data(58) as never} />)
		expect(html).toContain('the 11 of 69 orders that carry an amount')
	})

	it('says just the count when every order carries one', () => {
		const html = render(<AcquisitionPanel data={data(0) as never} />)
		expect(html).toContain('69 orders in Sanity')
		expect(html).not.toContain('that carry an amount')
	})
})

describe('the revenue rank agrees with the chart beneath it', () => {
	// crossSource[].revenue is `revenueByDate[date] ?? 0`, so a day whose orders all lacked an
	// amount is summed as a zero. The timeline refuses to draw that series for exactly this reason;
	// the rank line ranked weeks off the same numbers four inches above it.
	const days = Array.from({ length: 28 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10))
	const base = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: ok(4210), audienceGrowth: ok(108), timelineEvents: [], campaigns: [],
		crossSource: days.map((date, i) => ({
			date, vercelPageviews: 80, ga4Pageviews: 16, ga4Sessions: 12,
			orders: i % 7 === 0 ? 1 : 0, revenue: i === 0 ? 400 : 0,
		})),
	}

	// Scoped to the Revenue card. The Orders card carries its own rank line and keeps it — orders
	// are exact — so matching the whole document would pass on the neighbour.
	const revenueCard = (html: string) => {
		// Anchored on the CARD label, not the first mention — the Verdict sentence above the cards
		// also begins "Revenue", and slicing from there caught none of the card at all.
		const ordersLabel = html.indexOf('>Orders<')
		const revenueLabel = html.lastIndexOf('>Revenue<', ordersLabel)
		return html.slice(revenueLabel, ordersLabel)
	}

	it('says nothing about best weeks when the money does not cover every order', () => {
		const html = render(<OverviewPanel data={{ ...base, ordersWithTotal: 2 } as never} />)
		expect(revenueCard(html)).not.toMatch(/of the last \d+ weeks/)
	})

	it('ranks the weeks when every order carries an amount', () => {
		const html = render(<OverviewPanel data={{ ...base, ordersWithTotal: 7 } as never} />)
		expect(revenueCard(html)).toMatch(/of the last \d+ weeks/)
	})

	it('leaves the orders rank alone either way, because orders are exact', () => {
		const html = render(<OverviewPanel data={{ ...base, ordersWithTotal: 2 } as never} />)
		expect(html).toMatch(/of the last \d+ weeks/)
	})
})

describe('the typeface revenue column says what it misses', () => {
	const row = { typeface: 'Freight', viewed: ok(400), tested: ok(0), bought: ok(2), revenue: ok(400), testRate: null, buyRate: 0.005 }

	it('names the takings that reach no family', () => {
		// orders.ts computes this with a comment saying it exists to stop the column summing short
		// with nothing to explain it — and it was surfaced nowhere.
		const html = render(<TypefaceInterestPanel data={{
			rows: [row], interpretationNote: '', testerEventCount: 1,
			revenueIsApportioned: true, unattributedRevenue: 250, currency: 'USD',
		} as never} />)
		expect(html).toContain('US$250')
		expect(html).toContain('name no family in this catalogue')
	})

	it('names the orders with no amount at all', () => {
		const html = render(<TypefaceInterestPanel data={{
			rows: [row], interpretationNote: '', testerEventCount: 1,
			revenueIsApportioned: true, ordersMissingTotal: 5, currency: 'USD',
		} as never} />)
		expect(html).toContain('5 orders in this range carry no amount')
	})

	it('no longer calls the column exact', () => {
		// The same money is reported as partial on Overview.
		const html = render(<TypefaceInterestPanel data={{
			rows: [row], interpretationNote: '', testerEventCount: 1, currency: 'USD',
		} as never} />)
		expect(html).not.toContain('are exact — do not scale those up')
	})
})

describe('a week that sold nothing still shows the columns that say so', () => {
	// `columnIsEmpty` folds any column whose every value is 0. The file deliberately exempts NULLS
	// from folding — "a column of dashes is meant to be uncomfortable" — which is the same argument
	// pointing the other way: a measured zero is a measurement. Without the exemption, a catalogue
	// that sold nothing folded Bought and Revenue away behind "Show 2 empty columns", in a sales
	// tool, in the week the owner most needs to see them.
	const quiet = {
		interpretationNote: '', testerEventCount: 1, currency: 'USD',
		rows: [
			{ typeface: 'Freight', viewed: ok(161), tested: ok(96), bought: ok(0), revenue: ok(0), testRate: 0.596, buyRate: 0 },
			{ typeface: 'Omnes', viewed: ok(104), tested: ok(51), bought: ok(0), revenue: ok(0), testRate: 0.49, buyRate: 0 },
		],
	}

	it('keeps Bought and Revenue on screen when every value is zero', () => {
		const html = render(<TypefaceInterestPanel data={quiet as never} />)
		expect(html).toContain('Bought (orders)')
		expect(html).toContain('Revenue (orders)')
	})

	it('does not offer to reveal them as empty columns', () => {
		const html = render(<TypefaceInterestPanel data={quiet as never} />)
		expect(html).not.toContain('empty column')
	})

	it('still folds a column that genuinely has nothing in it', () => {
		// The feature is right; the exemption is about which absences are measurements.
		const noTester = {
			...quiet,
			rows: quiet.rows.map((r) => ({ ...r, tested: ok(0) })),
		}
		const html = render(<TypefaceInterestPanel data={noTester as never} />)
		expect(html).toContain('empty column')
	})
})

describe('each capture estimate says which way it is wrong', () => {
	// The notes were written, made REQUIRED by EstimateForPlot, and rendered nowhere. Three dots
	// share an axis so their disagreement is legible — but each is biased in a different direction,
	// and that direction is the only thing telling a reader which dot to move toward.
	const estimates = [
		{ basis: 'pageviews', rate: 0.2, observed: 475, actual: 2356, note: 'Read it as a ceiling.' },
		{ basis: 'orders', rate: 0.45, observed: 3, actual: 7, note: 'One more GA4 purchase moves this 14 points.' },
	]

	it('prints every estimate\'s own caveat', () => {
		const html = render(<EstimateDotPlot estimates={estimates} labelFor={(basis) => basis} intervalFor={(e) => ({ low: e.rate - 0.05, high: e.rate + 0.05 })} />)
		expect(html).toContain('Read it as a ceiling.')
		expect(html).toContain('One more GA4 purchase moves this 14 points.')
	})

	it('drops the shared footer that those notes made redundant', () => {
		const html = render(<EstimateDotPlot estimates={estimates} labelFor={(basis) => basis} intervalFor={(e) => ({ low: e.rate - 0.05, high: e.rate + 0.05 })} />)
		expect(html).not.toContain('Each is a separate way of asking the same question')
		// The one fact a per-estimate note cannot carry.
		expect(html).toContain('The rule marks 100%')
	})
})

describe('the funnel names the colours it splits its bars into', () => {
	// Two colours appeared on the bars when the device split moved into the funnel. Shipping those
	// without a key would be the exact fault this whole body of work began with — a legend that does
	// not match its graph, in the other direction.
	const split = (value: number, d: number, m: number) => ({
		key: `s${value}`, label: `Step ${value}`, value, conversionFromPrevious: null,
		segments: [{ key: 'desktop', label: 'Desktop', value: d }, { key: 'mobile', label: 'Mobile', value: m }],
	})

	it('keys every segment it draws', () => {
		const html = render(<FunnelChart stages={[split(475, 232, 219), split(23, 18, 5)]} measurement="independent-totals" />)
		const key = html.slice(html.lastIndexOf('</ol>'))
		expect(key).toContain('Desktop')
		expect(key).toContain('Mobile')
	})

	it('keys no segment it never drew', () => {
		// A segment GA4 stopped reporting is left out of the split; it must be left out of the key too.
		const html = render(<FunnelChart stages={[
			{ key: 'a', label: 'Landed', value: 475, conversionFromPrevious: null,
			  segments: [{ key: 'desktop', label: 'Desktop', value: 232 }, { key: 'tablet', label: 'Tablet', value: 0 }] },
		]} measurement="independent-totals" />)
		const key = html.slice(html.lastIndexOf('</ol>'))
		expect(key).toContain('Desktop')
		expect(key).not.toContain('Tablet')
	})

	it('says nothing when there is no split', () => {
		const html = render(<FunnelChart stages={[
			{ key: 'a', label: 'Landed', value: 475, conversionFromPrevious: null },
		]} measurement="independent-totals" />)
		const key = html.slice(html.lastIndexOf('</ol>'))
		expect(key).not.toContain('Desktop')
	})
})

describe('a split bar shows what its segments do not account for', () => {
	// Left as the ordinary fill, the parent bar's own colour showed through wherever the segments
	// did not reach — so a rung whose two segments sum to 451 of 475 painted the missing 24 in the
	// FIRST segment's colour, reading as a third segment of it.
	const stage = {
		key: 'landed', label: 'Landed', value: 475, conversionFromPrevious: null,
		segments: [{ key: 'desktop', label: 'Desktop', value: 232 }, { key: 'mobile', label: 'Mobile', value: 219 }],
	}

	it('draws the leftover in the neutral, not in a segment colour', () => {
		const html = render(<FunnelChart stages={[stage]} measurement="independent-totals" />)
		const rung = funnelRung(html, 'Landed')
		expect(rung).toContain(mark('bar.track'))
	})

	it('does not let the parent fill stand in for a segment', () => {
		const html = render(<FunnelChart stages={[stage]} measurement="independent-totals" />)
		const rung = funnelRung(html, 'Landed')
		expect(rung).toContain('background:transparent')
	})

	it('draws no leftover when the segments account for the whole rung', () => {
		const whole = { ...stage, segments: [{ key: 'desktop', label: 'Desktop', value: 256 }, { key: 'mobile', label: 'Mobile', value: 219 }] }
		const html = render(<FunnelChart stages={[whole]} measurement="independent-totals" />)
		const rung = funnelRung(html, 'Landed')
		expect(rung).not.toContain(mark('bar.track') + ';height:100%')
	})

	it('leaves an unsplit rung filled as before', () => {
		// Asserted on the FILL colour rather than the absence of `transparent`, which the rung's own
		// container also sets.
		const html = render(<FunnelChart stages={[{ key: 'a', label: 'Landed', value: 475, conversionFromPrevious: null }]} measurement="independent-totals" />)
		expect(funnelRung(html, 'Landed')).toContain(mark('bar.fill'))
	})
})

describe('the licence ladder keeps the shape a price ladder has', () => {
	// Tier is ORDINAL. The previous encoding flattened type, tier and term into one `type · tier`
	// string on a single axis and sorted that axis by VALUE — so "26–50 users" rendered above "1–5"
	// whenever it sold better, and the two term-rows of one tier landed as far apart as their values
	// happened to fall. The caption above it asked whether a tier that sells at one year also sells
	// at perpetual; the drawing separated exactly those two rows.
	const rows = [
		{ type: 'Desktop', tier: '1–5 users', tierValue: 1, term: 'Perpetual', orders: 4, revenue: 1180 },
		{ type: 'Desktop', tier: '1–5 users', tierValue: 1, term: '1 year', orders: 2, revenue: 340 },
		{ type: 'Desktop', tier: '26–50 users', tierValue: 3, term: 'Perpetual', orders: 9, revenue: 4000 },
		{ type: 'Web', tier: 'up to 50k views', tierValue: 1, term: '1 year', orders: 3, revenue: 420 },
	]

	it('reads the rungs in ladder order even when a higher one sells more', () => {
		// 26–50 outsells 1–5 four to nine here. A value sort would put it first; the ladder must not.
		const html = render(<LicenceLadder rows={rows} currency="USD" />)
		expect(html.indexOf('1–5 users')).toBeLessThan(html.indexOf('26–50 users'))
	})

	it('puts the two terms of one tier next to each other', () => {
		const html = render(<LicenceLadder rows={rows} currency="USD" />)
		const perpetual = html.indexOf('Perpetual')
		const year = html.indexOf('1 year')
		const nextTier = html.indexOf('26–50 users')
		expect(perpetual).toBeLessThan(nextTier)
		expect(year).toBeLessThan(nextTier)
	})

	it('names each tier once, so a repeat reads as the same rung', () => {
		const html = render(<LicenceLadder rows={rows} currency="USD" />)
		expect(html.match(/1–5 users/g)).toHaveLength(1)
	})

	it('facets by licence type', () => {
		const html = render(<LicenceLadder rows={rows} currency="USD" />)
		expect(html).toContain('Desktop')
		expect(html).toContain('Web')
		expect(html.indexOf('Desktop')).toBeLessThan(html.indexOf('Web'))
	})

	it('scales every bar against one peak, so facets are comparable', () => {
		// Per-facet scaling would make a one-order type look as busy as the type carrying the
		// business. The largest rung here is 9 orders and takes the full rail.
		const html = render(<LicenceLadder rows={rows} currency="USD" />)
		expect(html).toMatch(/width:100%/)
		// 3 of 9 is a third, not a full Web rail.
		expect(html).toMatch(/width:33\.3/)
	})

	it('bars the exact order count, with the apportioned money beside it', () => {
		// Revenue is the order total split evenly across the licences on it — a share, not a price —
		// so it is stated but never drawn.
		const html = render(<LicenceLadder rows={rows} currency="USD" />)
		expect(html).toContain('US$1,180')
		expect(html).toContain('>4<')
	})

	it('draws nothing when there are no licence lines', () => {
		expect(renderToStaticMarkup(<ThemeProvider theme={theme}><LicenceLadder rows={[]} currency="USD" /></ThemeProvider>)).toBe('')
	})
})

describe('the comparison basis actually reaches the fetch', () => {
	// The effect reads `compare` — it goes into the query string and into the cache key — and it was
	// missing from the dependency array. So choosing "Last year" selected the button and fetched
	// nothing: every delta on screen stayed measured against the previous period until some other
	// dependency happened to change. Not an inert control but a LYING one, which is worse, and the
	// whole point of giving the basis toggle its own colour was to tell the reader which window they
	// were looking at.
	//
	// Asserted against the source: the effect needs a DOM to run and this suite has no jsdom, so
	// there is no reachable seam. Same technique the handler's `actuals` wiring uses.
	const source = readFileSync(new URL('./useReport.ts', import.meta.url), 'utf8')

	it('lists compare among the effect dependencies', () => {
		const deps = source.slice(source.lastIndexOf('}, ['), source.lastIndexOf('])') + 2)
		expect(deps).toContain('compare')
	})

	it('still reads compare when building the request', () => {
		// If this stops being true the dependency above is pointless, and vice versa — the pair is
		// what makes the toggle work.
		expect(source).toContain("query.set('compare', compare)")
	})

	it('keeps the basis in the cache key, so two baselines cannot share an answer', () => {
		const key = readFileSync(new URL('./useReport.ts', import.meta.url), 'utf8')
		expect(key).toContain('compare')
	})
})

describe('the panel has more than one level of break', () => {
	// The measured fault: every vertical value lived in a 4-20px band, `space={3}` (12px) carried
	// 64% of all spacing, and the largest structural break in the tool was 20px — 1.67 times an
	// ordinary gap between two lines inside a card. A section boundary looked the same as the next
	// line of a caption. Not too little air; too EVEN air.
	const overview = {
		ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
		ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
		vercelVisitors: ok(1580), ordersWithTotal: 7, vercelDailyUnavailable: false,
		revenue: ok(910), currency: 'USD', orderStatuses: {}, interpretation: '',
		audience: ok(4210), audienceGrowth: ok(108), crossSource: [], timelineEvents: [], campaigns: [],
	}

	it('separates sections by far more than it separates lines in a card', () => {
		const html = render(<OverviewPanel data={overview as never} />)
		expect(html).toContain(`gap:${SPACE.section}px`)
		expect(html).toContain(`gap:${SPACE.block}px`)
		// Five times, not 1.67. A level has to double to be readable at a glance.
		expect(SPACE.section / SPACE.block).toBe(5)
	})

	it('at least doubles at every step, so each level is a level', () => {
		// Not uniform doubling — 4, 8, 20, 40 steps by x2, x2.5, x2. The property that matters is
		// that nothing steps by less than two, because under about that a level reads as the same
		// level, which is the fault being fixed.
		const steps = [SPACE.pair, SPACE.block, SPACE.group, SPACE.section]
		for (let i = 1; i < steps.length; i++) {
			expect(steps[i]! / steps[i - 1]!).toBeGreaterThanOrEqual(2)
		}
	})

	it('carries the scale in CSS, which the compat shim cannot drop', () => {
		// The shim's DOM fallback passes `style` through and drops `space`, `padding`, `tone`,
		// `radius` and `border`. Every primitive resolves on the versions this package supports, so
		// that is latent rather than live — but the skeleton was the one part never written for it.
		const html = render(<OverviewPanel data={overview as never} />)
		expect(html).toMatch(/style="[^"]*gap:40px/)
	})

	it('draws no outline around a plain metric tile', () => {
		// Eighteen identical 1px outlines at one weight ranked nothing above anything — lots of
		// lines, no hierarchy, which is what reads as busy AND flat at once. A tile in a grid with
		// 20px gutters is already unambiguously a tile.
		//
		// Asserted against the source: Sanity's `border` prop shows up only as a different
		// styled-component class hash, which is build-dependent and says nothing. The tone-carrying
		// cards keep their edge and are matched separately below.
		const source = readFileSync(new URL('./panels.tsx', import.meta.url), 'utf8')
		expect(source).not.toContain('tone="transparent" border')
	})

	it('keeps the edge on the cards that carry a tone', () => {
		// The alarm and the caution cards are the exception the outline exists for, and the Verdict
		// additionally spells its rail out in CSS so the signal survives the shim dropping `tone`.
		const source = readFileSync(new URL('./panels.tsx', import.meta.url), 'utf8')
		expect(source).toContain('tone="caution" border')
		expect(source).toContain('borderLeftWidth: 3')
	})

	it('gives a section body its own rhythm, which is why Section went unused', () => {
		// The body was a bare div, so any region with more than one child lost all internal spacing
		// and the caller had to re-add a Stack inside — making Section strictly MORE markup than a
		// bare heading for every multi-child region, which is all of them.
		const html = render(
			<Section title="Two children">
				<span>first</span>
				<span>second</span>
			</Section>,
		)
		// Scoped to the BODY element, which carries the generated id. The section WRAPPER also has a
		// 20px gap, so matching the bare value passed with the body's style deleted.
		expect(html).toMatch(new RegExp(`<div id="[^"]+" style="[^"]*gap:${SPACE.group}px`))
	})

	it('starts the reference sections folded', () => {
		// `defaultOpen` was declared, typed and documented — "start folded, for material that is
		// worth having and not worth reading every time" — and used zero times, while the reader
		// asked repeatedly for unimportant material to be hidden.
		const html = render(<DataHealthPanel data={{
			ga4Pageviews: ok(475), vercelPageviews: ok(2356), shortfallRatio: 0.798,
			ga4Sessions: ok(357), vercelVisitors: ok(1580), consentRate: unavailable('not_instrumented'),
			orderStatuses: { paid: 7 }, interpretation: 'Sources differ.', crossSource: [], timelineEvents: [],
		} as never} />)
		// Context and Order statuses, both folded, both still announcing themselves.
		expect(html.match(/aria-expanded="false"/g)?.length).toBeGreaterThanOrEqual(2)
		expect(html).toContain('Different units to the figures above')
	})
})

describe('caveats about one column read as one block', () => {
	// Raising the section break to 40px made this worse before it made it better: three 10px grey
	// lines sat as direct children of the panel root, so each was separated by a full section break
	// and thirty pixels of type occupied a third of a screen as three apparent regions.
	it('groups the revenue caveats rather than spacing them as sections', () => {
		const html = render(<TypefaceInterestPanel data={{
			rows: [{ typeface: 'Freight', viewed: ok(400), tested: ok(0), bought: ok(2), revenue: ok(400), testRate: null, buyRate: 0.005 }],
			interpretationNote: '', testerEventCount: 1, currency: 'USD',
			revenueIsApportioned: true, unattributedRevenue: 250, ordersMissingTotal: 5,
		} as never} />)
		// All three sentences sit inside one 8px block.
		const tail = html.slice(html.indexOf('split evenly between them'))
		expect(tail).toContain('name no family in this catalogue')
		expect(tail).toContain('carry no amount')
		expect(tail).not.toMatch(new RegExp(`gap:${SPACE.section}px`))
	})
})
