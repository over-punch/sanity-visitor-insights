/**
 * One time axis, every source stacked against it.
 *
 * This is the only view in the tool that answers a question no single source can: did the thing we
 * did move the thing we care about. A campaign goes out on Tuesday — did traffic rise, did revenue
 * follow, and did GA4 even see it. Vercel knows the traffic, Sanity knows the money, Mailchimp
 * knows the send date, and GA4 knows a lossy fraction of the behaviour in between.
 *
 * SMALL MULTIPLES, NOT A DUAL AXIS. Putting pageviews and revenue on one pair of axes requires
 * choosing a scale factor between them, and whatever is chosen manufactures a visual correlation
 * that the data did not claim — two lines can be made to cross, diverge or track by nothing more
 * than the ratio picked. Stacked rows sharing one x axis show the same co-movement and assert
 * nothing about relative magnitude, because each row carries its own y axis and its own units.
 *
 * COMPLETENESS IS DRAWN. A series from a source that misses things is dashed and carries a shaded
 * band up to its estimated true value; a complete source is a solid line. The reader learns which
 * numbers are facts and which are a fifth of the facts without being told twice.
 *
 * d3 is used for scales and path generation only — pure functions in, path strings out. No
 * d3-selection, so nothing here touches the DOM and the whole chart renders under
 * renderToStaticMarkup, which is how the tests exercise it.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Stack, Text } from '@liiift-studio/sanity-ui-compat'
import { scaleUtc, scaleLinear } from 'd3-scale'
import { line as d3Line, area as d3Area, curveMonotoneX } from 'd3-shape'
import { max as d3Max } from 'd3-array'
import { formatCount, formatMoney, formatPercent } from './Figure'

/** One point on one series. `value` null where the source reported nothing for that day. */
export interface SeriesPoint {
	date: string
	value: number | null
}

/** How a value should be written out. */
export type SeriesUnit = 'count' | 'money' | 'percent'

/**
 * One row of the chart: one answer, with what a lossier source saw underneath it.
 *
 * A row shows a SINGLE line by default. Two peer lines make the reader reconcile before they get
 * an answer, and at a glance a foundry owner wants "how much", not "here are two measurements that
 * disagree". The disagreement is still drawn — as a filled region, and in full on hover — because
 * hiding it entirely would switch off the alarm: the 24 August collapse was visible precisely
 * because two lines came apart.
 */
export interface Series {
	key: string
	label: string
	/** Which upstream the LINE came from. */
	source: 'GA4' | 'Vercel' | 'Sanity' | 'Mailchimp'
	/** Whether the line's source sees everything. Drives the stroke and the wording. */
	complete: boolean
	unit: SeriesUnit
	points: SeriesPoint[]
	/**
	 * What a lossier source saw of the same thing.
	 *
	 * Drawn as a filled region between the two, NOT as a symmetric uncertainty band. There is no
	 * doubt about the traffic here: Vercel counted it server-side. What is uncertain is how much of
	 * it the analytics could see, and the honest way to draw that is the area it missed — a
	 * quantity, visible to scale, rather than a percentage on another tab.
	 */
	shortfall?: {
		label: string
		source: Series['source']
		points: SeriesPoint[]
	}
	/**
	 * Multiplier from observed to estimated-true, where the line itself is the lossy source.
	 *
	 * This one IS a symmetric band, because it is genuine uncertainty rather than a known blind
	 * spot. The two must not look alike: one says "we do not know exactly", the other says "we know
	 * exactly, and this much was invisible".
	 */
	grossUpFactor?: number
}

/** A dated event drawn through every row, e.g. a campaign send. */
export interface TimelineMarker {
	date: string
	label: string
	detail?: string
}

/** Props for CrossSourceTimeline. */
export interface CrossSourceTimelineProps {
	series: Series[]
	markers?: TimelineMarker[]
	/** ISO 4217 code for any `money` series. */
	currency?: string | null
}

/** Height of one series row, in px. Enough for a readable shape without dominating the panel. */
const ROW_HEIGHT = 74
/** Space under the last row for the shared date axis. */
const AXIS_HEIGHT = 26
/** Left gutter for each row's own y-axis labels. */
const GUTTER = 52
const RIGHT_PAD = 12
const TOP_PAD = 16

/** Format a value in its series' unit. */
function formatValue(value: number, unit: SeriesUnit, currency: string | null | undefined): string {
	if (unit === 'money') return formatMoney(value, currency ?? null)
	if (unit === 'percent') return formatPercent(value, 1)
	return formatCount(value)
}

/** Short date for an axis tick: `5 Sep`. */
function tickLabel(date: Date): string {
	return `${date.getUTCDate()} ${date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

/**
 * The cross-source timeline.
 *
 * Renders nothing rather than an empty frame when there is not enough to plot — two points cannot
 * show a shape, and an axis with one dot on it invites a reading it cannot support.
 */
export function CrossSourceTimeline({ series, markers = [], currency }: CrossSourceTimelineProps): React.ReactElement | null {
	const [hoverIndex, setHoverIndex] = useState<number | null>(null)
	// Whether to draw the constituent sources. Hover reveals them; so does keyboard focus and the
	// explicit toggle, because a chart whose detail exists only under a pointer is unreachable on a
	// phone and to anyone navigating by keyboard.
	const [pinned, setPinned] = useState(false)
	const frameRef = useRef<SVGSVGElement | null>(null)

	// Every date any series reported, ascending. Built from the union so a series with a gap does
	// not shorten the axis for the others.
	const dates = useMemo(() => {
		const all = new Set<string>()
		for (const s of series) for (const p of s.points) all.add(p.date)
		return [...all].sort()
	}, [series])

	const width = 100 // percentage-based viewBox; the SVG scales to its container
	const plotWidth = width - GUTTER - RIGHT_PAD
	const height = TOP_PAD + series.length * ROW_HEIGHT + AXIS_HEIGHT

	const x = useMemo(() => {
		if (dates.length === 0) return null
		return scaleUtc()
			.domain([new Date(`${dates[0]}T00:00:00Z`), new Date(`${dates[dates.length - 1]}T00:00:00Z`)])
			.range([GUTTER, GUTTER + plotWidth])
	}, [dates, plotWidth])

	const onMove = useCallback(
		(event: React.MouseEvent<SVGSVGElement>) => {
			const frame = frameRef.current
			if (!frame || dates.length === 0) return
			const box = frame.getBoundingClientRect()
			// Position within the plot, in the same 0–100 space as the viewBox.
			const ratio = ((event.clientX - box.left) / box.width) * width
			const clamped = Math.max(GUTTER, Math.min(GUTTER + plotWidth, ratio))
			const index = Math.round(((clamped - GUTTER) / plotWidth) * (dates.length - 1))
			setHoverIndex(Math.max(0, Math.min(dates.length - 1, index)))
		},
		[dates.length, plotWidth],
	)

	if (dates.length < 3 || series.length === 0 || !x) return null

	const hoveredDate = hoverIndex !== null ? dates[hoverIndex] : null
	const revealed = pinned || hoverIndex !== null

	return (
		<Stack space={3}>
			<div style={frameStyle}>
				<svg
					ref={frameRef}
					viewBox={`0 0 ${width} ${height}`}
					preserveAspectRatio="none"
					style={{ width: '100%', height: series.length * ROW_HEIGHT + AXIS_HEIGHT + TOP_PAD, display: 'block' }}
					onMouseMove={onMove}
					onMouseLeave={() => setHoverIndex(null)}
					role="img"
					aria-label={`${series.map((s) => s.label).join(', ')} over ${dates.length} days, on one shared time axis`}
				>
					{series.map((row, rowIndex) => {
						const top = TOP_PAD + rowIndex * ROW_HEIGHT
						const bottom = top + ROW_HEIGHT - 18

						const values = row.points.map((p) => p.value).filter((v): v is number => v !== null)
						// Each row scales to ITSELF. That is the whole point of small multiples: no
						// shared scale means no invented correlation between rows.
						const peak = d3Max(values) ?? 0
						const grossed = row.grossUpFactor && row.grossUpFactor > 1 ? peak * row.grossUpFactor : peak
						const y = scaleLinear().domain([0, grossed || 1]).nice().range([bottom, top])

						const at = (p: SeriesPoint) => x(new Date(`${p.date}T00:00:00Z`))
						const defined = (p: SeriesPoint) => p.value !== null

						const lineGen = d3Line<SeriesPoint>().defined(defined).x(at).y((p) => y(p.value as number)).curve(curveMonotoneX)

						// The blind spot: the area between what happened and what the lossier source
						// saw of it. Filled, not outlined, because it is a QUANTITY — the traffic the
						// analytics missed, drawn to scale, rather than a percentage on another tab.
						// Always visible, never hover-gated: the 24 August collapse announced itself
						// as this region widening, and putting that behind an interaction would
						// switch the alarm off.
						const shortfallPoints = row.shortfall?.points ?? []
						const byDate = new Map(shortfallPoints.map((p) => [p.date, p.value]))
						const gapGen = d3Area<SeriesPoint>()
							.defined((p) => p.value !== null && byDate.get(p.date) != null)
							.x(at)
							.y0((p) => y(byDate.get(p.date) as number))
							.y1((p) => y(p.value as number))
							.curve(curveMonotoneX)

						// Genuine uncertainty, where the LINE itself is the lossy source. A symmetric
						// band, deliberately unlike the blind-spot fill: one says "we do not know
						// exactly", the other says "we know exactly, and this much was invisible".
						const bandGen = d3Area<SeriesPoint>()
							.defined(defined)
							.x(at)
							.y0((p) => y(p.value as number))
							.y1((p) => y((p.value as number) * (row.grossUpFactor as number)))
							.curve(curveMonotoneX)

						const path = lineGen(row.points) ?? ''
						const gap = row.shortfall ? gapGen(row.points) ?? '' : ''
						const band = row.grossUpFactor && row.grossUpFactor > 1 ? bandGen(row.points) ?? '' : ''
						// The lossier source's own line, revealed only while reading a day.
						const shortfallLine = row.shortfall && revealed
							? lineGen(shortfallPoints.filter((p) => p.value !== null)) ?? ''
							: ''

						return (
							<g key={row.key}>
								<line x1={GUTTER} x2={GUTTER + plotWidth} y1={bottom} y2={bottom} stroke="currentColor" strokeWidth={0.15} opacity={0.25} />
								<text x={GUTTER - 4} y={top + 5} textAnchor="end" fontSize={3} fill="currentColor" opacity={0.55}>
									{formatValue(grossed, row.unit, currency)}
								</text>
								<text x={GUTTER - 4} y={bottom} textAnchor="end" fontSize={3} fill="currentColor" opacity={0.55}>0</text>

								{gap && <path d={gap} fill="currentColor" opacity={revealed ? 0.16 : 0.09} />}
								{band && <path d={band} fill="currentColor" opacity={0.1} />}

								{shortfallLine && (
									<path d={shortfallLine} fill="none" stroke="currentColor" strokeWidth={0.35} strokeDasharray="1.5 1" opacity={0.75} />
								)}

								<path
									d={path}
									fill="none"
									stroke="currentColor"
									strokeWidth={0.5}
									// Dashed only where the LINE's own source misses things. A row whose
									// line is complete stays solid even when it carries a blind-spot fill.
									strokeDasharray={row.complete ? undefined : '1.5 1'}
									opacity={row.complete ? 0.95 : 0.7}
								/>
							</g>
						)
					})}

					{/* Campaign sends and other dated events, drawn through every row at once — which
					    is the only way to see whether one moved the others. */}
					{markers.map((marker) => {
						const at = x(new Date(`${marker.date}T00:00:00Z`))
						if (!Number.isFinite(at)) return null
						return (
							<g key={`${marker.date}-${marker.label}`}>
								<line
									x1={at}
									x2={at}
									y1={TOP_PAD - 6}
									y2={TOP_PAD + series.length * ROW_HEIGHT - 18}
									stroke="currentColor"
									strokeWidth={0.3}
									strokeDasharray="0.8 0.8"
									opacity={0.5}
								/>
								<circle cx={at} cy={TOP_PAD - 8} r={0.9} fill="currentColor" opacity={0.7} />
							</g>
						)
					})}

					{hoveredDate && (
						<line
							x1={x(new Date(`${hoveredDate}T00:00:00Z`))}
							x2={x(new Date(`${hoveredDate}T00:00:00Z`))}
							y1={TOP_PAD - 6}
							y2={TOP_PAD + series.length * ROW_HEIGHT - 18}
							stroke="currentColor"
							strokeWidth={0.25}
							opacity={0.8}
						/>
					)}

					{/* The shared date axis, once, at the bottom. Ticks are the ends and the middle —
					    enough to orient without crowding a chart this wide. */}
					{[0, Math.floor(dates.length / 2), dates.length - 1].map((index, position) => {
						const date = dates[index]
						if (!date) return null
						return (
							<text
								key={date}
								x={x(new Date(`${date}T00:00:00Z`))}
								y={height - 6}
								textAnchor={position === 0 ? 'start' : position === 2 ? 'end' : 'middle'}
								fontSize={3}
								fill="currentColor"
								opacity={0.55}
							>
								{tickLabel(new Date(`${date}T00:00:00Z`))}
							</text>
						)
					})}
				</svg>
			</div>

			{/* The readout. Every series at the hovered date, so the co-movement question is answered
			    in numbers as well as in shape. */}
			<div style={readoutRow} aria-live="polite">
				<Text size={0} weight="medium">
					{hoveredDate ? tickLabel(new Date(`${hoveredDate}T00:00:00Z`)) : 'Hover the chart to read a day'}
				</Text>
				{hoveredDate && series.map((row) => {
					const point = row.points.find((p) => p.date === hoveredDate)
					const seen = row.shortfall?.points.find((p) => p.date === hoveredDate)
					return (
						<Text key={row.key} size={0} muted>
							{row.label}:{' '}
							{point && point.value !== null ? formatValue(point.value, row.unit, currency) : '—'}
							{/* The constituent source, revealed alongside rather than instead. Reading
							    "2,356 · GA4 saw 475" is the whole point: one answer, and how much of
							    it your analytics could account for. */}
							{seen && seen.value !== null && (
								<> · {row.shortfall?.source} saw {formatValue(seen.value, row.unit, currency)}</>
							)}
						</Text>
					)
				})}
				{hoveredDate && markers.filter((m) => m.date === hoveredDate).map((m) => (
					<Text key={m.label} size={0}>· {m.label}</Text>
				))}
			</div>

			<div style={legendRow}>
				{series.some((row) => row.shortfall) && (
					// Hover is not available on touch and not reachable by keyboard, so the reveal
					// has an explicit control too. Without it the detail would exist only for people
					// using a mouse.
					<button
						type="button"
						style={revealButton}
						aria-pressed={pinned}
						onClick={() => setPinned((current) => !current)}
					>
						{pinned ? 'Hide what each source saw' : 'Show what each source saw'}
					</button>
				)}
					{series.map((row) => (
					<Text key={row.key} size={0} muted>
						<span aria-hidden="true">{row.complete ? '───' : '╌╌╌'}</span> {row.label} ({row.source})
					</Text>
				))}
				{series.some((row) => row.shortfall) && (
					<Text size={0} muted>
						The shaded area is what your analytics did not see. It is a quantity, not a margin of
						error — the traffic happened, GA4 just missed it.
					</Text>
				)}
				{series.some((row) => !row.complete && row.grossUpFactor) && (
					<Text size={0} muted>
						A dashed line is a lossy source; the band above it is where the true figure probably sits.
					</Text>
				)}
				{markers.length > 0 && <Text size={0} muted>Vertical rules mark campaign sends.</Text>}
			</div>
		</Stack>
	)
}

/** Chart frame. */
const frameStyle: React.CSSProperties = { width: '100%', overflow: 'hidden' }

/** The hover readout: every series at one date, wrapping on a narrow pane. */
const readoutRow: React.CSSProperties = {
	display: 'flex',
	gap: 14,
	flexWrap: 'wrap',
	alignItems: 'baseline',
	minHeight: 18,
}

/** The explicit reveal control, so the detail is not pointer-only. */
const revealButton: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.3))',
	borderRadius: 3,
	color: 'inherit',
	font: 'inherit',
	fontSize: '0.8em',
	padding: '3px 8px',
	cursor: 'pointer',
	whiteSpace: 'nowrap',
}

/** Legend, wrapping rather than overflowing. */
const legendRow: React.CSSProperties = {
	display: 'flex',
	gap: 14,
	flexWrap: 'wrap',
	alignItems: 'center',
}
