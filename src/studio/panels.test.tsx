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
		expect(html.match(/width:100%;height:100%/g)).toHaveLength(2)
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
						{ source: 'fontsinuse.com', channel: 'Referral', sessions: 300, designIndustry: true, unattributed: false },
						{ source: '(not set)', channel: 'Unassigned', sessions: 100, designIndustry: false, unattributed: true },
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
						{ source: 'fontsinuse.com', channel: 'Referral', sessions: 300, designIndustry: true, unattributed: false },
						{ source: '(direct)', channel: 'Direct', sessions: 100, designIndustry: false, unattributed: true },
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
						{ source: 'fontsinuse.com', channel: 'Referral', sessions: 300, designIndustry: true, unattributed: false },
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
			interpretation: 'Sources differ.',
		} as never

		expect(() => render(<MeasurementHealthPanel data={legacy} />)).not.toThrow()
		expect(render(<MeasurementHealthPanel data={legacy} />)).toContain('475')
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
			<MeasurementHealthPanel
				data={{
					ga4Pageviews: ok(543), vercelPageviews: ok(2392), shortfallRatio: 0.773,
					ga4Sessions: ok(357), orders: ok(7), consentRate: unavailable('not_instrumented'),
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
