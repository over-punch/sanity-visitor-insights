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

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import {
	AcquisitionPanel,
	DiagnosticsPanel,
	JourneyPanel,
	MeasurementHealthPanel,
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
import { MetricFigure, NoticeList, TrendChart } from './Figure'
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

	it('states the reason for every unavailable variant', () => {
		const reasons = ['not_instrumented', 'before_cutover', 'suppressed', 'outage', 'source_error', 'not_applicable'] as const
		for (const reason of reasons) {
			const html = render(<MetricFigure metric={unavailable(reason)} label="Views" />)
			// Rendered somewhere as an accessible label, so a screen reader gets more than a dash.
			expect(html, reason).toMatch(/aria-label="[^"]+"/)
		}
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
			<MeasurementHealthPanel
				data={{
					ga4Pageviews: ok(33486), vercelPageviews: ok(33597), shortfallRatio: 0.0033,
					ga4Sessions: ok(22781), orders: ok(64), consentRate: ok(78.4),
					interpretation: 'Sources agree.', daily: [],
				}}
			/>,
		)
		expect(html).toContain('33,486')
		expect(html).toContain('Sources agree.')
	})

	it('renders when GA4 is dead without inventing a shortfall', () => {
		const html = render(
			<MeasurementHealthPanel
				data={{
					ga4Pageviews: unavailable('source_error'), vercelPageviews: ok(2620), shortfallRatio: null,
					ga4Sessions: unavailable('source_error'), orders: ok(12), consentRate: unavailable('source_error'),
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
		topLandingPages: [{ path: '/', sessions: 8940 }],
	}

	it('renders a funnel mixing working, uninstrumented and outage rungs', () => {
		const html = render(<JourneyPanel data={data} />)
		expect(html).toContain('Landed')
		expect(html).toContain('Used the type tester')
		expect(html).toContain('33,486')
	})

	it('always shows the approximation note', () => {
		expect(render(<JourneyPanel data={data} />)).toContain('not tracked journeys')
	})

	it('renders an uninstrumented rung as a dash rather than a zero', () => {
		const html = render(<JourneyPanel data={data} />)
		// A zero here would read as "nobody reached this step", which is the opposite of the truth.
		expect(html).not.toMatch(/>0</)
		expect(html).toContain('—')
	})
})

describe('AcquisitionPanel', () => {
	it('renders sources and flags the special segments', () => {
		const html = render(
			<AcquisitionPanel
				data={{
					totalSessions: 1000, designIndustryShare: 0.3, unattributedShare: 0.1, rowsWithheld: true, rowsTruncated: false,
					rows: [
						{ source: 'fontsinuse.com', channel: 'Referral', sessions: 300, designIndustry: true, unattributed: false },
						{ source: '(not set)', channel: 'Unassigned', sessions: 100, designIndustry: false, unattributed: true },
					],
				}}
			/>,
		)
		expect(html).toContain('fontsinuse.com')
		expect(html).toContain('design industry')
		expect(html).toContain('unattributed')
		// Withheld rows must be admitted, or the list reads as exhaustive.
		expect(html).toContain('withheld')
	})
})

describe('TypefaceInterestPanel', () => {
	it('renders mixed availability across columns', () => {
		const html = render(
			<TypefaceInterestPanel
				data={{
					rowsWithheld: false,
					interpretationNote: 'Aggregate interest per family, not individual journeys.',
					rows: [
						{ typeface: 'Omnes', viewed: ok(3792), tested: ok(910), bought: ok(21), testRate: 0.24 },
						{ typeface: 'Gamay', viewed: ok(1040), tested: unavailable('not_instrumented'), bought: unavailable('not_applicable'), testRate: null },
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
		expect(html).toContain('Everything checked out')
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
		expect(html).toContain('Example Foundry')
	})

	it('still accepts flat props, for direct use outside a Studio', () => {
		const html = render(
			React.createElement(VisitorInsightsTool, {
				apiBaseUrl: 'https://example.com',
				siteLabel: 'Flat Props Foundry',
			}),
		)
		expect(html).toContain('Flat Props Foundry')
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

	it('draws a line for each source', () => {
		const html = render(<TrendChart points={series} />)
		expect(html).toContain('<svg')
		// Two paths: one solid, one dashed.
		expect((html.match(/<path/g) ?? []).length).toBe(2)
		expect(html).toContain('stroke-dasharray')
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
			interpretation: 'Sources differ.',
		} as never

		expect(() => render(<MeasurementHealthPanel data={legacy} />)).not.toThrow()
		expect(render(<MeasurementHealthPanel data={legacy} />)).toContain('475')
	})

	it('journey renders without landing pages', () => {
		const legacy = {
			steps: [{ key: 'landed', label: 'Landed', event: 'page_view', count: ok(100), conversionFromPrevious: null }],
			approximate: true, approximationNote: 'Independent totals.',
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
