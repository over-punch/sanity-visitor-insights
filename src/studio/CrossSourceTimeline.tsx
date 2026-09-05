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

/** One row of the chart. */
export interface Series {
	key: string
	label: string
	/** Which upstream this came from, shown so the reader can weigh it. */
	source: 'GA4' | 'Vercel' | 'Sanity' | 'Mailchimp'
	/**
	 * Whether the source sees everything. GA4 does not; the others do.
	 * Drives the dashed stroke and the uncertainty band rather than a footnote nobody reads.
	 */
	complete: boolean
	unit: SeriesUnit
	points: SeriesPoint[]
	/**
	 * Multiplier from observed to estimated-true, for a lossy series. 1 means no correction known.
	 * Drawn as a band above the line, never as a replacement for it — the measured line stays.
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

						const defined = (p: SeriesPoint) => p.value !== null
						const lineGen = d3Line<SeriesPoint>()
							.defined(defined)
							.x((p) => x(new Date(`${p.date}T00:00:00Z`)))
							.y((p) => y(p.value as number))
							.curve(curveMonotoneX)

						// The band between what was measured and what it probably was. Drawn only for
						// a lossy source with a known correction, and never instead of the line.
						const bandGen = d3Area<SeriesPoint>()
							.defined(defined)
							.x((p) => x(new Date(`${p.date}T00:00:00Z`)))
							.y0((p) => y(p.value as number))
							.y1((p) => y((p.value as number) * (row.grossUpFactor as number)))
							.curve(curveMonotoneX)

						const path = lineGen(row.points) ?? ''
						const band = row.grossUpFactor && row.grossUpFactor > 1 ? bandGen(row.points) ?? '' : ''

						return (
							<g key={row.key}>
								<line x1={GUTTER} x2={GUTTER + plotWidth} y1={bottom} y2={bottom} stroke="currentColor" strokeWidth={0.15} opacity={0.25} />
								<text x={GUTTER - 4} y={top + 5} textAnchor="end" fontSize={3} fill="currentColor" opacity={0.55}>
									{formatValue(grossed, row.unit, currency)}
								</text>
								<text x={GUTTER - 4} y={bottom} textAnchor="end" fontSize={3} fill="currentColor" opacity={0.55}>0</text>

								{band && <path d={band} fill="currentColor" opacity={0.1} />}
								<path
									d={path}
									fill="none"
									stroke="currentColor"
									strokeWidth={0.5}
									// Dashed means the source misses things. Carried by the stroke rather
									// than by colour, so it survives a monochrome or colour-blind reading.
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
					return (
						<Text key={row.key} size={0} muted>
							{row.label}:{' '}
							{point && point.value !== null ? formatValue(point.value, row.unit, currency) : '—'}
						</Text>
					)
				})}
				{hoveredDate && markers.filter((m) => m.date === hoveredDate).map((m) => (
					<Text key={m.label} size={0}>· {m.label}</Text>
				))}
			</div>

			<div style={legendRow}>
				{series.map((row) => (
					<Text key={row.key} size={0} muted>
						<span aria-hidden="true">{row.complete ? '───' : '╌╌╌'}</span> {row.label} ({row.source})
					</Text>
				))}
				{series.some((row) => !row.complete) && (
					<Text size={0} muted>
						Dashed means the source misses things. The shaded band is where the figure probably sits.
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

/** Legend, wrapping rather than overflowing. */
const legendRow: React.CSSProperties = {
	display: 'flex',
	gap: 14,
	flexWrap: 'wrap',
	alignItems: 'center',
}
