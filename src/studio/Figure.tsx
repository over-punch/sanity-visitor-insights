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

import React from 'react'
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
export function SortableTable<Row>({ caption, columns, rows, rowKey, initialSort }: SortableTableProps<Row>): React.ReactElement {
	const [sort, setSort] = React.useState<{ key: string; desc: boolean } | null>(
		initialSort ? { key: initialSort, desc: true } : null,
	)

	const active = sort ? columns.find((c) => c.key === sort.key) : undefined

	const ordered = React.useMemo(() => {
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
	}, [rows, active, sort])

	const toggle = (column: SortColumn<Row>) => {
		setSort((current) => {
			if (current?.key !== column.key) return { key: column.key, desc: Boolean(column.numeric) }
			return { key: column.key, desc: !current.desc }
		})
	}

	return (
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
					{ordered.map((row) => (
						<tr key={rowKey(row)}>
							{columns.map((column, index) => {
								const content = column.render(row)
								return index === 0 ? (
									<th key={column.key} scope="row" style={bodyCell}>{content}</th>
								) : (
									<td key={column.key} style={column.numeric ? bodyCellNumeric : bodyCell}>{content}</td>
								)
							})}
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	)
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
