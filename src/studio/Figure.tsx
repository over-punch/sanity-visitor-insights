/**
 * Shared renderers for metric values and comparison bars.
 *
 * Two rules are enforced here rather than left to each panel:
 *
 *   1. An unavailable metric renders as an em dash with a stated reason — never as "0". A missing
 *      measurement and a measured zero mean opposite things, and must never look alike.
 *   2. Nothing is distinguished by colour alone. Bars carry a text value, a percentage and an
 *      accessible label, so the figure survives greyscale, colour blindness and both Studio themes.
 */

import React, { useRef, useState } from 'react'
import { Badge, Box, Card, Flex, Stack, Text, Tooltip } from '@liiift-studio/sanity-ui-compat'
import type { MetricValue, UnavailableReason } from '../types'

/** Human-readable explanation for each unavailable reason. */
const REASON_TEXT: Record<UnavailableReason, string> = {
	not_instrumented: 'Not tracked on this site',
	before_cutover: 'Not tracked during this period',
	suppressed: 'Withheld by GA4 for privacy',
	outage: 'Not recorded during part of this period',
	source_error: 'Source did not respond',
	not_applicable: 'Does not apply to this site',
}

/** Format a number with thousands separators. */
export function formatCount(value: number): string {
	return new Intl.NumberFormat('en-GB').format(Math.round(value))
}

/** Format a 0–1 ratio as a percentage. */
export function formatPercent(ratio: number, digits = 0): string {
	return `${(ratio * 100).toFixed(digits)}%`
}

/** Props for MetricFigure. */
/** Format a money value in the site's currency, falling back to a plain number. */
export function formatMoney(value: number, currency: string | null): string {
	if (!currency) return formatCount(Math.round(value))
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency,
			maximumFractionDigits: value >= 1000 ? 0 : 2,
		}).format(value)
	} catch {
		// An unrecognised ISO code must not blank the figure.
		return `${formatCount(Math.round(value))} ${currency}`
	}
}

/** Props for Delta. */
export interface DeltaProps {
	/** This period's value, or null when it could not be measured. */
	current: number | null
	/** The previous equivalent period's value, or null when there is no comparison. */
	previous: number | null
	/**
	 * Whether a rise is good. Sessions and revenue: yes. A shortfall or a bounce figure: no.
	 * Drives only the wording and the tone, never whether the number is shown.
	 */
	riseIsGood?: boolean
	/** Render as a percentage-point change rather than a percentage change of a percentage. */
	unit?: 'count' | 'percent'
}

/**
 * A period-over-period change.
 *
 * Every figure in this tool used to be a bare level, which at these volumes is close to
 * meaningless: "389 sessions" is neither good nor bad without last week beside it, and the
 * 24 August collapse would have announced itself on every panel as a delta while going unnoticed
 * for over a week as a level.
 *
 * Renders nothing at all when there is no comparison — an absent delta must never be drawn as
 * "no change", which is a different and much more reassuring claim.
 */
export function Delta({ current, previous, riseIsGood = true, unit = 'count' }: DeltaProps): React.ReactElement | null {
	// isFinite, not a null check. An older API route sends undefined for a field it does not know
	// about, and a NaN can reach here from a division the server got wrong — both pass `!== null`
	// and render "NaN%" beside a confident arrow.
	if (!Number.isFinite(current as number) || !Number.isFinite(previous as number)) return null
	const now = current as number
	const before = previous as number

	const absolute = now - before

	if (absolute === 0) {
		return <span style={deltaStyle('flat')}>no change</span>
	}

	// A change from zero has no defined percentage in either direction. "+∞%" is what a naive
	// division produces, and asserting `change` non-null let a fall to zero print "↓ 0%".
	const change = before === 0 ? null : absolute / Math.abs(before)
	const rising = absolute > 0
	const tone = rising === riseIsGood ? 'good' : 'bad'
	const arrow = rising ? '\u2191' : '\u2193'

	// The baseline is formatted in the figure's own unit. Reading "Previous period: 43" under a
	// 43.2% consent rate is the same defect MetricFigure's `unit` was added to fix.
	const baseline = unit === 'percent' ? `${before.toFixed(1)}%` : formatCount(before)

	const magnitude = change === null
		? (rising ? 'new' : 'gone')
		: unit === 'percent'
			// Percentage points, not a percentage of a percentage: a consent rate moving 40% → 44%
			// rose by 4 points, and calling that "+10%" is a different and confusing claim.
			? `${rising ? '+' : ''}${absolute.toFixed(1)} pts`
			: `${rising ? '+' : ''}${formatPercent(change, 0)}`

	return (
		<span style={deltaStyle(tone)} title={`Previous period: ${baseline}`}>
			<span aria-hidden="true">{arrow}</span>
			{' '}
			{magnitude}
			<span style={visuallyHidden}>
				{' '}compared with {baseline} in the previous period
			</span>
		</span>
	)
}

/**
 * Delta styling. Direction is carried by the arrow and the words as well as the colour, so the
 * meaning survives a monochrome or colour-blind reading.
 */
function deltaStyle(tone: 'good' | 'bad' | 'flat'): React.CSSProperties {
	// A bad move is set in a heavier weight and full opacity; a good one recedes. `riseIsGood` used
	// to compute this tone and then map both values to the same colour and opacity, so a rising
	// Unattributed figure looked identical to a rising Sessions figure — the one distinction the
	// prop exists to draw. Weight and opacity rather than hue, so it survives a monochrome reading
	// and does not collide with the Studio's own semantic colours.
	return {
		fontFamily: 'inherit',
		fontSize: '0.8em',
		fontWeight: tone === 'bad' ? 600 : 500,
		opacity: tone === 'flat' ? 0.55 : tone === 'bad' ? 1 : 0.7,
		color: 'currentColor',
		whiteSpace: 'nowrap',
		// A bad move gets a rule under it, so direction is not carried by weight alone.
		borderBottom: tone === 'bad' ? '1px solid currentColor' : 'none',
	}
}

export interface MetricFigureProps {
	metric: MetricValue
	/** Accessible label describing what this number counts. */
	label: string
	size?: number
	/**
	 * What the number IS, which decides how it is written.
	 *
	 * MetricValue carries availability but not unit, so a percentage and a count arrive here
	 * indistinguishable and both used to be written with the count formatter. The consent rate is a
	 * 0-100 percentage: it rendered as a bare "84" beside "GA4 sessions 357" and "Orders 7", where
	 * the obvious reading is 84 sessions out of 357 — a quarter — when the truth is 84%. A missing
	 * suffix inverted the conclusion.
	 *
	 * 'percent' expects a 0-100 value, matching what measurementHealth produces.
	 */
	unit?: 'count' | 'percent'
}

/**
 * Render a metric value, handling the absent case visibly.
 * Screen readers get the reason text rather than an unexplained dash.
 */
export function MetricFigure({ metric, label, size = 4, unit = 'count' }: MetricFigureProps): React.ReactElement {
	if (metric.status === 'unavailable') {
		const reason = REASON_TEXT[metric.reason]
		const detail = metric.detail ? `${reason}. ${metric.detail}` : reason

		return (
			<Tooltip content={<Box padding={2}><Text size={1}>{detail}</Text></Box>} portal>
				<Text size={size} muted aria-label={`${label}: unavailable. ${detail}`}>
					<span aria-hidden="true">—</span>
				</Text>
			</Tooltip>
		)
	}

	// Percentages keep one decimal, since that is the precision the server produced; rounding to a
	// whole number here would make a 0.4-point move look like no move at all.
	const formatted = unit === 'percent' ? `${metric.value.toFixed(1)}%` : formatCount(metric.value)

	if (metric.status === 'partial') {
		return (
			<Stack space={2}>
				<Text size={size} aria-label={`${label}: ${formatted}, partial. ${metric.note}`}>
					{formatted}
				</Text>
				<Badge tone="caution" fontSize={0}>Partial</Badge>
			</Stack>
		)
	}

	return (
		<Text size={size} aria-label={`${label}: ${formatted}`}>
			{formatted}
		</Text>
	)
}

/** Props for ComparisonBar. */
export interface ComparisonBarProps {
	label: string
	metric: MetricValue
	/** Largest value across the sibling bars, used to scale width. */
	max: number
	/** Tone conveys category, but never carries meaning on its own. */
	tone?: 'primary' | 'positive' | 'caution' | 'default'
}

/**
 * A horizontal bar with its value printed alongside.
 *
 * Deliberately CSS rather than a charting library: these panels compare and rank a handful of
 * values, which a labelled bar does as well as a chart while avoiding a large dependency in the
 * Studio bundle and the theme-token bridging that a chart library would need for light and dark.
 */
export function ComparisonBar({ label, metric, max, tone = 'default' }: ComparisonBarProps): React.ReactElement {
	const value = metric.status === 'unavailable' ? null : metric.value
	const width = value !== null && max > 0 ? Math.max(2, (value / max) * 100) : 0

	return (
		<Stack space={2}>
			<div style={barHeader}>
				<Text size={1} weight="medium">{label}</Text>
				<MetricFigure metric={metric} label={label} size={1} />
			</div>

			{value === null ? (
				// A dashed rail, not a zero-width bar: absence must not read as a measured zero.
				<Card
					aria-hidden="true"
					radius={2}
					tone="transparent"
					border
					style={{ height: 8, borderStyle: 'dashed' }}
				/>
			) : (
				// Track and fill are both Cards so the palette comes from the Studio theme tokens
				// rather than hand-picked CSS variables, and follows light/dark without extra work.
				<Card aria-hidden="true" radius={2} tone="transparent" border style={{ height: 8, overflow: 'hidden' }}>
					<Card tone={tone === 'default' ? 'default' : tone} radius={2} style={{ width: `${width}%`, height: '100%' }} />
				</Card>
			)}
		</Stack>
	)
}

/** One rung of the funnel, already filtered to steps that are actually measured. */
export interface FunnelStage {
	key: string
	label: string
	/** Distinct users at this step. */
	value: number
	/** Share of the previous shown step, or null when it could not be computed. */
	conversionFromPrevious: number | null
}

/** Props for FunnelChart. */
export interface FunnelChartProps {
	stages: FunnelStage[]
	/**
	 * Whether the stages are a tracked sequence or independent totals. The drawing is the same
	 * shape either way, but the words between stages are not: a fallback's gap is a difference
	 * between two counts, not people who dropped out.
	 */
	measurement: 'sequence' | 'independent-totals'
}

/**
 * A funnel.
 *
 * Widths are a share of the FIRST stage rather than of the largest, which is what makes it read as
 * a funnel: every rung answers "of everyone who arrived, how many got this far". Anchoring to the
 * max instead would make the widest stage full-width wherever it sat, and a mid-funnel step wider
 * than entry — which happens on the independent-totals fallback, where `add_to_cart` can exceed
 * `page_view` — would silently rescale everything above it.
 *
 * Stages are focusable so the figures are reachable without a pointer; the readout is rendered as
 * text under the stage rather than as a floating tooltip so it is also visible on touch.
 */
export function FunnelChart({ stages, measurement }: FunnelChartProps): React.ReactElement | null {
	const [activeKey, setActiveKey] = useState<string | null>(null)
	const refs = useRef<Array<HTMLDivElement | null>>([])

	const entry = stages[0]?.value ?? 0
	if (stages.length === 0) return null

	const onKeyDown = (event: React.KeyboardEvent, index: number) => {
		let next: number | null = null
		if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(index + 1, stages.length - 1)
		if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(index - 1, 0)
		if (event.key === 'Home') next = 0
		if (event.key === 'End') next = stages.length - 1
		if (next === null) return
		event.preventDefault()
		refs.current[next]?.focus()
	}

	return (
		<ol style={funnelList}>
			{stages.map((stage, index) => {
				const previous = index > 0 ? stages[index - 1] : null
				// The share is printed unclamped and the WIDTH is clamped separately. Clamping the
				// share itself printed a fallback stage of 500 against an entry of 100 as "100.0%
				// of landed" — the one reading that hides the anomaly the caveat exists to explain.
				const share = entry > 0 ? stage.value / entry : 0
				const width = Math.max(1.5, Math.min(1, share) * 100)
				const active = activeKey === stage.key
				const delta = previous ? previous.value - stage.value : 0

				return (
					<li key={stage.key} style={funnelItem}>
						{previous && (
							<div style={funnelGap} aria-hidden="true">
								<Text size={0} muted>{gapLabel(delta, measurement)}</Text>
							</div>
						)}

						<div
							ref={(el: HTMLDivElement | null) => {
								refs.current[index] = el
							}}
							tabIndex={0}
							role="listitem"
							style={funnelStage(active)}
							onMouseEnter={() => setActiveKey(stage.key)}
							onMouseLeave={() => setActiveKey(null)}
							onFocus={() => setActiveKey(stage.key)}
							onBlur={() => setActiveKey(null)}
							onKeyDown={(e) => onKeyDown(e, index)}
						>
							<div style={barHeader}>
								<Text size={1} weight="medium">{stage.label}</Text>
								<Text size={1} weight="semibold">{formatCount(stage.value)}</Text>
							</div>

							<Card aria-hidden="true" radius={2} tone="transparent" border style={funnelTrack}>
								<Card tone="primary" radius={2} style={{ width: `${width}%`, height: '100%' }} />
							</Card>

							{/* Both ratios where they differ — the panel used to print only the
							    step-to-step one, and a reader comparing two adjacent small
							    percentages had no way to see how narrow the funnel had already
							    become. On stage two the previous step IS entry, so printing both
							    read as "100.0% of landed · 500.0% of landed". */}
							<Text size={0} muted>
								{index === 0
									? 'entry step'
									: `${formatPercent(share, 1)} of ${stages[0]?.label.toLowerCase()}`}
								{index > 1 && stage.conversionFromPrevious !== null && previous
									? ` · ${formatPercent(stage.conversionFromPrevious, 1)} of ${previous.label.toLowerCase()}`
									: ''}
							</Text>
						</div>
					</li>
				)
			})}
		</ol>
	)
}

/**
 * The words in the gap between two rungs.
 *
 * A tracked funnel loses people; independent totals merely differ, and a later total can exceed an
 * earlier one — `add_to_cart` fires per selection on two of the three sites, so the cart step can
 * sit above `page_view`. That case must not print as "no difference", which is what a
 * greater-than-zero test alone produced.
 *
 * @param delta - previous step's value minus this one's; negative means this step is larger
 */
function gapLabel(delta: number, measurement: 'sequence' | 'independent-totals'): string {
	if (delta === 0) return measurement === 'sequence' ? 'no drop-off' : 'no difference'
	if (delta > 0) return measurement === 'sequence' ? `−${formatCount(delta)} did not continue` : `${formatCount(delta)} fewer`
	// A closed funnel cannot grow, so a negative here means the fallback is in use and the two
	// counts are of different acts, not of the same people continuing.
	return `${formatCount(-delta)} more — not a subset of the step above`
}

/** The funnel's list wrapper. Numbering is suppressed — the rungs are already in order visually. */
const funnelList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }

/** One rung and its preceding gap. */
const funnelItem: React.CSSProperties = { display: 'grid', gap: 4 }

/** The space between two rungs, where the drop-off is named. */
const funnelGap: React.CSSProperties = {
	display: 'flex',
	justifyContent: 'flex-end',
	padding: '4px 2px',
}

/** One rung. The active state is a background and a border, so it survives a forced-colours mode. */
function funnelStage(active: boolean): React.CSSProperties {
	return {
		display: 'grid',
		gap: 6,
		padding: '8px 10px',
		borderRadius: 3,
		border: `1px solid ${active ? 'currentColor' : 'transparent'}`,
		background: active ? 'var(--card-bg-color, rgba(128,128,128,0.08))' : 'transparent',
		cursor: 'default',
	}
}

/** The rung's track. */
const funnelTrack: React.CSSProperties = { height: 10, overflow: 'hidden' }

/** Chart frame, so the hover readout can sit over the plot. */
const chartFrame: React.CSSProperties = { position: 'relative', width: '100%' }

/** Hover readout, pinned top-right of the plot and out of the lines' way. */
const readout: React.CSSProperties = {
	position: 'absolute',
	top: 0,
	right: 0,
	padding: '6px 10px',
	borderRadius: 3,
	background: 'var(--card-bg-color, rgba(0,0,0,0.55))',
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.35))',
	pointerEvents: 'none',
	maxWidth: '70%',
}

/** Bar header: label on the left, figure hard right, never overlapping on a narrow pane. */
const barHeader: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: 12,
	flexWrap: 'wrap',
}

/** Chart legend, wrapping rather than overflowing. */
const legendRow: React.CSSProperties = {
	display: 'flex',
	gap: 12,
	alignItems: 'center',
	flexWrap: 'wrap',
}

/** Disclosure control for the collapsed caveats. Underlined so it reads as actionable text. */
const disclosure: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: 'none',
	color: 'inherit',
	opacity: 0.75,
	font: 'inherit',
	fontSize: '0.85em',
	padding: '2px 0',
	textDecoration: 'underline',
	textUnderlineOffset: 3,
	cursor: 'pointer',
	justifySelf: 'start',
	width: 'fit-content',
}

/** Notice row: badge and text side by side, wrapping on a narrow panel rather than colliding. */
const noticeRow: React.CSSProperties = {
	display: 'flex',
	gap: 12,
	alignItems: 'flex-start',
	flexWrap: 'wrap',
}

/** The badge keeps its width; only the text reflows. */
const noticeBadge: React.CSSProperties = { flex: '0 0 auto' }

/** Props for NoticeList. */
export interface NoticeListProps {
	notices: string[]
}

/**
 * Caveats attached to a report — sampling, processing lag, instrumentation cutovers.
 * Rendered in the panel rather than a README: a caveat nobody sees does not prevent a wrong read.
 */
export function NoticeList({ notices }: NoticeListProps): React.ReactElement | null {
	const [expanded, setExpanded] = React.useState(false)

	if (notices.length === 0) return null

	// Two is the most a reader will actually take in before the band becomes wallpaper. Beyond that
	// the rest collapse behind a count, because a stack of seven identical amber cards above the
	// data trains people to skip the one that mattered — and every caveat here is emitted on every
	// panel, relevant or not, so the stack is routinely long.
	const alwaysShown = notices.slice(0, 2)
	const hidden = notices.slice(2)

	const item = (notice: string) => (
		<li key={notice}>
			<Card padding={3} radius={2} tone="caution" border>
				{/* Laid out with real CSS rather than the UI kit's Flex and its `gap` token. When
				    the compat shim cannot resolve Flex it renders a plain div, and a token number
				    means nothing to CSS — so the badge and the text landed on top of each other
				    and the notice read "Caveasubscribe is counted…". */}
				<div style={noticeRow}>
					<span style={noticeBadge}>
						<Badge tone="caution" fontSize={0}>Caveat</Badge>
					</span>
					<Text size={1}>{notice}</Text>
				</div>
			</Card>
		</li>
	)

	return (
		<Stack space={2}>
			{/* A real list element, so a screen reader announces how many caveats there are. */}
			<ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
				{alwaysShown.map(item)}
				{expanded && hidden.map(item)}
			</ul>

			{hidden.length > 0 && (
				<button
					type="button"
					style={disclosure}
					onClick={() => setExpanded((open) => !open)}
					aria-expanded={expanded}
				>
					{expanded
						? 'Show fewer caveats'
						: `${hidden.length} more ${hidden.length === 1 ? 'caveat' : 'caveats'}`}
				</button>
			)}
		</Stack>
	)
}

/** Props for TrendChart. */
export interface TrendChartProps {
	/** Daily points, oldest first. */
	points: Array<{ date: string; ga4: number | null; vercel: number | null }>
	/** Accessible description of what the two lines are. */
	label?: string
}

/** Plot geometry, in the SVG's own coordinate space. */
const CHART = { w: 760, h: 240, left: 52, right: 12, top: 16, bottom: 30 }

/** Round a maximum up to a readable axis top: 1, 2 or 5 times a power of ten. */
function niceCeiling(value: number): number {
	if (value <= 0) return 1
	const magnitude = 10 ** Math.floor(Math.log10(value))
	const normalised = value / magnitude
	const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10
	return step * magnitude
}

/** "2026-08-24" to "24 Aug", for axis ticks. */
function shortDate(iso: string): string {
	const parsed = new Date(`${iso}T00:00:00Z`)
	if (Number.isNaN(parsed.getTime())) return iso
	return `${parsed.getUTCDate()} ${parsed.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

/**
 * Daily GA4 against Vercel, with axes, dated ticks and a hover readout.
 *
 * The shaded band between the lines is the point of the chart rather than decoration: it IS the
 * measurement gap, and seeing where it opens is what distinguishes an incident from a standing
 * difference. Darden's opened overnight on 2026-08-24 and stayed open for over a week, which no
 * scalar on this panel could have shown.
 *
 * Inline SVG with no charting library — one dependency-free element in a Studio that already loads
 * a great deal, and it renders on the server so the tests can assert on it. Strokes use
 * currentColor so the whole thing follows the Studio's theme without a palette of its own.
 */
export function TrendChart({ points, label = 'Daily pageviews, GA4 against Vercel' }: TrendChartProps): React.ReactElement | null {
	const [hovered, setHovered] = React.useState<number | null>(null)

	// Two points cannot show a trend, and one cannot show anything.
	if (points.length < 3) return null

	const values = points.flatMap((p) => [p.ga4, p.vercel]).filter((v): v is number => typeof v === 'number')
	if (values.length === 0) return null

	const max = niceCeiling(Math.max(...values, 1))
	const plotW = CHART.w - CHART.left - CHART.right
	const plotH = CHART.h - CHART.top - CHART.bottom

	const x = (i: number) => CHART.left + (i / Math.max(1, points.length - 1)) * plotW
	const y = (v: number) => CHART.top + plotH - (v / max) * plotH

	/**
	 * Build a path, breaking wherever a source has no figure for a day.
	 * A gap must read as absent, not as a line drawn through zero.
	 */
	const line = (pick: (p: TrendChartProps['points'][number]) => number | null) => {
		let d = ''
		let penDown = false
		points.forEach((p, i) => {
			const v = pick(p)
			if (typeof v !== 'number') { penDown = false; return }
			d += `${penDown ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
			penDown = true
		})
		return d.trim()
	}

	// The band between the lines, drawn only across runs where BOTH sources reported — shading a
	// stretch where one is missing would invent a gap out of an absence.
	const bands: string[] = []
	let run: number[] = []
	const flushRun = () => {
		if (run.length > 1) {
			const top = run.map((i) => `${x(i).toFixed(1)} ${y(points[i]!.vercel as number).toFixed(1)}`)
			const bottom = [...run].reverse().map((i) => `${x(i).toFixed(1)} ${y(points[i]!.ga4 as number).toFixed(1)}`)
			bands.push(`M${top.join(' L')} L${bottom.join(' L')} Z`)
		}
		run = []
	}
	points.forEach((p, i) => {
		if (typeof p.ga4 === 'number' && typeof p.vercel === 'number') run.push(i)
		else flushRun()
	})
	flushRun()

	// Four horizontal gridlines, including zero and the top.
	const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ value: max * f, y: y(max * f) }))

	// At most six date labels, so they never collide however narrow the pane.
	const labelEvery = Math.max(1, Math.ceil(points.length / 6))
	const dateTicks = points
		.map((p, i) => ({ i, date: p.date }))
		.filter(({ i }) => i % labelEvery === 0 || i === points.length - 1)

	const active = hovered !== null ? points[hovered] : null
	const activeGap = active && typeof active.ga4 === 'number' && typeof active.vercel === 'number' && active.vercel > 0
		? (active.vercel - active.ga4) / active.vercel
		: null

	/**
	 * Arrow keys step through days, so the readout is reachable without a mouse.
	 *
	 * A hover-only readout hands keyboard and touch users a picture they cannot interrogate, which
	 * is the same failure as the tooltip-only explanations elsewhere in this file. Home and End jump
	 * to the ends, Escape clears — the conventions a reader already expects from a listbox.
	 */
	const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
		const last = points.length - 1
		const current = hovered ?? 0
		const move = (next: number) => {
			event.preventDefault()
			setHovered(Math.max(0, Math.min(last, next)))
		}

		if (event.key === 'ArrowRight') return move(hovered === null ? 0 : current + 1)
		if (event.key === 'ArrowLeft') return move(hovered === null ? last : current - 1)
		if (event.key === 'Home') return move(0)
		if (event.key === 'End') return move(last)
		if (event.key === 'Escape') { setHovered(null); return }
	}

	/** Map a pointer position to the nearest day. */
	const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
		const box = event.currentTarget.getBoundingClientRect()
		if (box.width === 0) return
		// Pointer position in the SVG's own coordinates, since the element is scaled to its pane.
		const svgX = ((event.clientX - box.left) / box.width) * CHART.w
		const ratio = (svgX - CHART.left) / plotW
		const index = Math.round(ratio * (points.length - 1))
		setHovered(index >= 0 && index < points.length ? index : null)
	}

	return (
		<Stack space={3}>
			<div style={chartFrame}>
				<svg
					viewBox={`0 0 ${CHART.w} ${CHART.h}`}
					width="100%"
					style={{ display: 'block', height: 'auto' }}
					role="img"
					aria-label={`${label}, ${points[0]?.date} to ${points[points.length - 1]?.date}. Peak ${formatCount(max)} pageviews in a day.`}
					onMouseMove={onMove}
					onMouseLeave={() => setHovered(null)}
					onKeyDown={onKeyDown}
					onBlur={() => setHovered(null)}
					tabIndex={0}
					// Announced live so a screen-reader user hears the figures as they arrow across,
					// rather than only the static summary in aria-label.
					aria-describedby={active ? 'trend-readout' : undefined}
				>
					{/* Y axis: gridlines and labels */}
					{ticks.map((tick) => (
						<g key={tick.value}>
							<line
								x1={CHART.left} x2={CHART.w - CHART.right} y1={tick.y} y2={tick.y}
								stroke="currentColor" strokeOpacity={tick.value === 0 ? 0.35 : 0.12} strokeWidth="1"
							/>
							<text
								x={CHART.left - 8} y={tick.y + 4} textAnchor="end"
								fontSize="11" fill="currentColor" fillOpacity="0.55"
							>
								{formatCount(tick.value)}
							</text>
						</g>
					))}

					{/* X axis: dated ticks */}
					{dateTicks.map(({ i, date }) => (
						<text
							key={date} x={x(i)} y={CHART.h - 10} textAnchor="middle"
							fontSize="11" fill="currentColor" fillOpacity="0.55"
						>
							{shortDate(date)}
						</text>
					))}

					{/* The gap itself */}
					{bands.map((d) => (
						<path key={d.slice(0, 24)} d={d} fill="currentColor" fillOpacity="0.09" stroke="none" />
					))}

					<path d={line((p) => p.vercel)} fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="2" />
					<path d={line((p) => p.ga4)} fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="2" strokeDasharray="5 3" />

					{/* Hover crosshair and markers */}
					{hovered !== null && active && (
						<g>
							<line
								x1={x(hovered)} x2={x(hovered)} y1={CHART.top} y2={CHART.top + plotH}
								stroke="currentColor" strokeOpacity="0.4" strokeWidth="1"
							/>
							{typeof active.vercel === 'number' && (
								<circle cx={x(hovered)} cy={y(active.vercel)} r="4" fill="currentColor" />
							)}
							{typeof active.ga4 === 'number' && (
								<circle cx={x(hovered)} cy={y(active.ga4)} r="4" fill="currentColor" />
							)}
						</g>
					)}
				</svg>

				{/* Readout. Rendered as markup rather than SVG text so it wraps and styles normally. */}
				{active && (
					<div style={readout} id="trend-readout" role="status" aria-live="polite">
						<Text size={1} weight="medium">{shortDate(active.date)}</Text>
						<Text size={1} muted>
							Vercel {typeof active.vercel === 'number' ? formatCount(active.vercel) : '—'}
							{'  ·  '}
							GA4 {typeof active.ga4 === 'number' ? formatCount(active.ga4) : '—'}
							{activeGap !== null ? `  ·  gap ${formatPercent(activeGap, 0)}` : ''}
						</Text>
					</div>
				)}
			</div>

			<div style={legendRow}>
				<Text size={0} muted>&#9473;&#9473; Vercel</Text>
				<Text size={0} muted>&#9476;&#9476; GA4</Text>
				<Text size={0} muted>shaded band is the gap</Text>
				{!active && <Text size={0} muted>hover, or focus and use arrow keys, for a day</Text>}
			</div>
		</Stack>
	)
}

/** One column of a sortable table. */
export interface SortColumn<Row> {
	/** Stable key, also used as the sort key. */
	key: string
	label: string
	/** Right-aligned and sorted high-to-low first, the way a reader expects of a figure. */
	numeric?: boolean
	/**
	 * Value to sort on. Return null for "no value" — those always sort last regardless of
	 * direction, because an unmeasured row is not a small one and must not lead an ascending sort.
	 */
	sortValue: (row: Row) => number | string | null
	/**
	 * Value written to the CSV, when it differs from the sort key.
	 *
	 * Defaults to `sortValue`, which is right for a plain count and wrong for anything formatted:
	 * a rate sorts on 0.4318 and displays 43%, revenue sorts on a bare number and displays a
	 * currency, and a column with a fallback displays something `sortValue` returns null for.
	 */
	exportValue?: (row: Row) => number | string | null
	render: (row: Row) => React.ReactNode
}

/** Props for SortableTable. */
export interface SortableTableProps<Row> {
	caption: string
	columns: Array<SortColumn<Row>>
	rows: Row[]
	rowKey: (row: Row) => string
	/** Column sorted on first load. Defaults to the server's own ordering. */
	initialSort?: string
	/**
	 * The text a row is matched against when filtering. Omit to render no filter box.
	 *
	 * Sorting was the tool's entire interaction budget, which meant a reader who spotted an
	 * unrelated site's traffic in the table had no way to take it out and see what was left.
	 */
	filterOn?: (row: Row) => string
	/** Placeholder for the filter box, naming what is searched. */
	filterPlaceholder?: string
	/** Base filename for the CSV export. Omit to render no export control. */
	exportName?: string
	/** Shown under the table when the server truncated the row set. */
	truncatedNote?: string
}

/**
 * A table whose columns sort.
 *
 * Both data tables arrived in one server-chosen order — sessions descending, views descending — so
 * the only question they could answer was the one that order encoded. Sorting by any column turns
 * the same rows into several different questions: which family is tested most relative to views,
 * which source is least attributed, which typeface sells without being looked at.
 *
 * Rows with no value for the active column sort last in both directions. That is deliberate: an
 * unavailable metric is not a zero, and letting it lead an ascending sort would restate exactly the
 * confusion the MetricValue type exists to prevent.
 */
export function SortableTable<Row>({
	caption,
	columns,
	rows,
	rowKey,
	initialSort,
	filterPlaceholder,
	filterOn,
	exportName,
	truncatedNote,
}: SortableTableProps<Row>): React.ReactElement {
	const [sort, setSort] = React.useState<{ key: string; desc: boolean } | null>(
		initialSort ? { key: initialSort, desc: true } : null,
	)
	const [query, setQuery] = React.useState('')
	const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(() => new Set())
	const [copied, setCopied] = React.useState<'idle' | 'done' | 'failed'>('idle')
	// Held so repeated clicks cannot stack timers and revert the label early, and so the pending
	// one is cleared on unmount.
	const copyTimer = React.useRef<number | null>(null)
	React.useEffect(() => () => {
		if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
	}, [])

	const active = sort ? columns.find((c) => c.key === sort.key) : undefined

	// Filtering and exclusion both happen before sorting, so the ranking is of what is shown.
	const visible = React.useMemo(() => {
		const needle = query.trim().toLowerCase()
		return rows.filter((row) => {
			if (excluded.has(rowKey(row))) return false
			if (!needle || !filterOn) return true
			return filterOn(row).toLowerCase().includes(needle)
		})
	}, [rows, query, excluded, filterOn, rowKey])

	const ordered = React.useMemo(() => {
		const rows = visible
		if (!active || !sort) return rows
		const copy = [...rows]
		copy.sort((a, b) => {
			const av = active.sortValue(a)
			const bv = active.sortValue(b)
			// Missing values sink, whichever way the column is pointing.
			if (av === null && bv === null) return 0
			if (av === null) return 1
			if (bv === null) return -1
			const cmp = typeof av === 'number' && typeof bv === 'number'
				? av - bv
				: String(av).localeCompare(String(bv))
			return sort.desc ? -cmp : cmp
		})
		return copy
	}, [visible, active, sort])

	const toggle = (column: SortColumn<Row>) => {
		setSort((current) => {
			if (current?.key !== column.key) return { key: column.key, desc: Boolean(column.numeric) }
			return { key: column.key, desc: !current.desc }
		})
	}

	/**
	 * Copy the visible rows to the clipboard as CSV.
	 *
	 * Clipboard rather than a download: the artifact viewer and the Studio both sandbox
	 * script-initiated downloads, and "paste into the email you were already writing" is the actual
	 * task. Exports what is on screen — filtered, sorted, minus exclusions — because a copy that
	 * silently differs from the table above it is worse than none.
	 */
	const copyCsv = async () => {
		const header = columns.map((column) => column.label)
		const lines = [header, ...ordered.map((row) => columns.map((column) => {
			// `exportValue` where a column defines one, because `sortValue` is a SORT KEY and is
			// routinely a different thing from what the cell shows: engagement sorts on 0.4318 and
			// displays 43%, revenue sorts on a bare number and displays a currency, and campaign
			// sorts on null where the cell shows the medium it falls back to. The comment below
			// promised a copy of what is on screen and delivered the sort keys instead.
			const value = column.exportValue ? column.exportValue(row) : column.sortValue(row)
			return value === null || value === undefined ? '' : String(value)
		}))]

		const csv = lines.map((cells) => cells.map(csvCell).join(',')).join('\n')

		try {
			await navigator.clipboard.writeText(csv)
			setCopied('done')
			if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
			copyTimer.current = window.setTimeout(() => setCopied('idle'), 2000)
		} catch {
			// Reachable, not exotic: navigator.clipboard is undefined in any non-secure context, so
			// a Studio served over plain http or on an internal IP lands here every time. It used
			// to set the flag back to idle, which rendered as the button doing nothing at all.
			setCopied('failed')
			if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
			copyTimer.current = window.setTimeout(() => setCopied('idle'), 4000)
		}
	}

	const hiddenCount = rows.length - visible.length

	return (
		<Stack space={2}>
			{(filterOn || exportName) && (
				<div style={tableControls}>
					{filterOn && (
						<input
							type="search"
							value={query}
							placeholder={filterPlaceholder ?? 'Filter rows'}
							aria-label={filterPlaceholder ?? 'Filter rows'}
							style={filterInput}
							onChange={(e) => setQuery(e.currentTarget.value)}
						/>
					)}
					{hiddenCount > 0 && (
						<Text size={0} muted>
							{hiddenCount} row{hiddenCount === 1 ? '' : 's'} hidden
							{excluded.size > 0 && (
								<>
									{' · '}
									<button type="button" style={inlineLink} onClick={() => setExcluded(new Set())}>
										restore excluded
									</button>
								</>
							)}
						</Text>
					)}
					<span style={{ flex: 1 }} />
					{exportName && (
						<button type="button" style={tableControlButton} onClick={() => void copyCsv()}>
							{copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy as CSV'}
						</button>
					)}
				</div>
			)}

		<Card radius={2} tone="transparent" border style={tableWrapper}>
			<table style={tableBase}>
				<caption style={visuallyHidden}>{caption}</caption>
				<thead>
					<tr>
						{columns.map((column) => {
							const isActive = sort?.key === column.key
							return (
								<th
									key={column.key}
									scope="col"
									style={column.numeric ? headCellNumeric : headCell}
									aria-sort={isActive ? (sort?.desc ? 'descending' : 'ascending') : 'none'}
								>
									<button type="button" style={sortButton(Boolean(column.numeric))} onClick={() => toggle(column)}>
										{column.label}
										{/* An arrow, not colour alone, so the sorted column is legible
										    to anyone. A dot marks the unsorted columns as sortable. */}
										<span aria-hidden="true" style={sortMark}>
											{isActive ? (sort?.desc ? '▼' : '▲') : '↕'}
										</span>
									</button>
								</th>
							)
						})}
					</tr>
				</thead>
				<tbody>
					{ordered.map((row) => {
						const key = rowKey(row)
						return (
							<tr key={key}>
								{columns.map((column, index) => {
									const content = column.render(row)
									return index === 0 ? (
										<th key={column.key} scope="row" style={bodyCell}>
											<span style={firstCell}>
												{content}
												{filterOn && (
													// Per-row exclusion, because the fix for a contaminated
													// table is to take the bad row out and see what the
													// rest looks like. Rendered on every row rather than
													// on hover so it is reachable by keyboard and touch.
													<button
														type="button"
														style={excludeButton}
														aria-label={`Exclude ${key}`}
														title={`Exclude ${key} from this table`}
														onClick={() => setExcluded((current) => new Set(current).add(key))}
													>
														×
													</button>
												)}
											</span>
										</th>
									) : (
										<td key={column.key} style={column.numeric ? bodyCellNumeric : bodyCell}>{content}</td>
									)
								})}
							</tr>
						)
					})}
					{ordered.length === 0 && (
						<tr>
							<td colSpan={columns.length} style={bodyCell}>
								<Text size={1} muted>No rows match this filter.</Text>
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</Card>

		{truncatedNote && <Text size={0} muted>{truncatedNote}</Text>}
		</Stack>
	)
}

/**
 * Escape one CSV cell.
 *
 * Quotes the separators, and neutralises a leading `=`, `+`, `-`, `@`, tab or carriage return.
 * That second part matters because source and campaign values are attacker-influenceable from
 * outside: anyone can request the site with `?utm_campaign==HYPERLINK("...")`, GA4 stores it, and
 * pasting the export into a spreadsheet would evaluate it as a live formula.
 */
function csvCell(cell: string): string {
	const neutralised = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
	return /[",\n]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised
}

/** The controls above a table: filter, hidden-row count, export. */
const tableControls: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 10,
	flexWrap: 'wrap',
}

/** The filter box. */
const filterInput: React.CSSProperties = {
	font: 'inherit',
	fontSize: '0.85em',
	padding: '4px 8px',
	borderRadius: 3,
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.3))',
	background: 'transparent',
	color: 'inherit',
	minWidth: 160,
}

/** A control sitting alongside a table, e.g. the CSV copy. */
const tableControlButton: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.3))',
	borderRadius: 3,
	color: 'inherit',
	font: 'inherit',
	fontSize: '0.8em',
	padding: '4px 9px',
	cursor: 'pointer',
	whiteSpace: 'nowrap',
}

/** An inline text button inside a muted line. */
const inlineLink: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: 'none',
	color: 'inherit',
	font: 'inherit',
	fontSize: 'inherit',
	padding: 0,
	textDecoration: 'underline',
	textUnderlineOffset: 2,
	cursor: 'pointer',
}

/** First cell layout: content, with the exclude control pushed to its right. */
const firstCell: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: 8,
}

/** The per-row exclude control. Quiet until focused or hovered. */
const excludeButton: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: 'none',
	color: 'inherit',
	font: 'inherit',
	fontSize: '1.05em',
	lineHeight: 1,
	opacity: 0.35,
	padding: '0 2px',
	cursor: 'pointer',
	flex: '0 0 auto',
}

/** Table scrolls inside its own container, so the panel never scrolls sideways. */
const tableWrapper: React.CSSProperties = { overflowX: 'auto', width: '100%' }

/** Base table geometry. */
const tableBase: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', minWidth: 420 }

/** Header cell: sticky-feeling separation from the body without a heavy rule. */
const headCell: React.CSSProperties = {
	padding: 0,
	textAlign: 'left',
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.3))',
	whiteSpace: 'nowrap',
}

const headCellNumeric: React.CSSProperties = { ...headCell, textAlign: 'right' }

const bodyCell: React.CSSProperties = {
	padding: '8px 12px',
	textAlign: 'left',
	fontWeight: 400,
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.18))',
}

const bodyCellNumeric: React.CSSProperties = {
	...bodyCell,
	textAlign: 'right',
	fontVariantNumeric: 'tabular-nums',
}

/** The whole header cell is the control, so the hit area matches what looks clickable. */
function sortButton(numeric: boolean): React.CSSProperties {
	return {
		appearance: 'none',
		background: 'transparent',
		border: 'none',
		color: 'inherit',
		font: 'inherit',
		fontSize: '0.78em',
		letterSpacing: '0.06em',
		textTransform: 'uppercase',
		opacity: 0.7,
		padding: '8px 12px',
		width: '100%',
		display: 'flex',
		gap: 6,
		alignItems: 'center',
		justifyContent: numeric ? 'flex-end' : 'flex-start',
		cursor: 'pointer',
	}
}

/** Sort indicator. */
const sortMark: React.CSSProperties = { opacity: 0.7, fontSize: '0.9em' }

/** Present to screen readers, absent visually — the caption names the table without repeating the heading. */
const visuallyHidden: React.CSSProperties = {
	position: 'absolute',
	width: 1,
	height: 1,
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap',
}
