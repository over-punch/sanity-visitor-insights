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
	/**
	 * How the row is drawn. Defaults to `line`.
	 *
	 * `events` is for a quantity that only exists on the days it happened — orders, revenue. Darden
	 * does seven orders a quarter, and a monotone curve through those seven points drew a smooth
	 * rise and fall across eighty-three days on which nothing occurred, with the curve's overshoot
	 * putting non-zero revenue on days that had none. A stem per day says what a sale is: a discrete
	 * event, on a date, of a size. Days with nothing draw nothing, which is the truth.
	 */
	mark?: 'line' | 'events'
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
	/**
	 * Called when the reader drags across a span, with inclusive ISO dates.
	 *
	 * Time is the only dimension all four sources genuinely share, which makes it the only thing
	 * worth linking on — a referrer row carries no date and a funnel step carries no source, so
	 * value-based cross-filtering would need dimensions the reports do not request and could not
	 * afford. Dragging a span and having every panel reflow to it is the whole of the cross-filter
	 * this data model supports, and it costs one callback: the range state already drives
	 * everything.
	 */
	onBrush?: (start: string, end: string) => void
}

/**
 * Design width, in the same units as every other constant here.
 *
 * The chart previously used a `0 0 100 H` viewBox with `preserveAspectRatio="none"` and a CSS
 * height equal to H — so the vertical scale was exactly 1 while the horizontal scale was
 * paneWidth/100, i.e. 4x to 12x. Under a non-uniform transform SVG scales the stroked OUTLINE, not
 * the stroke width, so line weight tracked slope, dash rhythm changed with both slope and pane
 * width, marker dots rendered as horizontal dashes, and `fontSize={AXIS_TYPE}` came out 3px tall and
 * stretched four- to twelve-fold sideways. Anamorphic letterforms, shipped to type designers.
 *
 * Worse, GUTTER was a pixel value pasted into a percentage space, so 52% of the chart was empty
 * margin and the data occupied 36% of the width.
 *
 * 760 matches TrendChart, which had this right all along. Uniform scaling, default
 * preserveAspectRatio, every constant in one space.
 */
const WIDTH = 760
/** Height of one series row. */
const ROW_HEIGHT = 74
/** Space under the last row for the shared date axis. */
const AXIS_HEIGHT = 26
/** Left gutter for each row's own y-axis labels — 7% of the width, not 52%. */
const GUTTER = 52
const RIGHT_PAD = 12
const TOP_PAD = 22
/** Type size inside the plot. A real value now that the scale is uniform. */
const AXIS_TYPE = 11
/**
 * Shortest span a brush may apply.
 *
 * Matches the chart's own render floor. Anything shorter narrows the range to a window the chart
 * cannot draw, which removes the control the reader would use to get back out.
 */
const MIN_BRUSH_DAYS = 3

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
export function CrossSourceTimeline({ series, markers = [], currency, onBrush }: CrossSourceTimelineProps): React.ReactElement | null {
	const [hoverIndex, setHoverIndex] = useState<number | null>(null)
	// Whether to draw the constituent sources. Hover reveals them; so does keyboard focus and the
	// explicit toggle, because a chart whose detail exists only under a pointer is unreachable on a
	// phone and to anyone navigating by keyboard.
	const [pinned, setPinned] = useState(false)
	/** Index the drag began at, or null when not dragging. */
	const [brushAnchor, setBrushAnchor] = useState<number | null>(null)
	/** The committed span, kept so the selection stays drawn after the pointer is released. */
	const [brushed, setBrushed] = useState<[number, number] | null>(null)
	/**
	 * The chart's rendered width in CSS pixels, so the viewBox can track it.
	 *
	 * With a FIXED 760-unit viewBox and height:auto, the uniform scale is paneWidth/760 — so
	 * `fontSize={11}` rendered at 5.8px in a 400px Studio pane and ~22px at full width, where the
	 * row labels came out larger than the section heading above them. The chart's height swung the
	 * same way, which made row height a function of how wide the pane happened to be.
	 *
	 * Making the viewBox equal the measured width pins the scale at exactly 1: type is 11px
	 * everywhere, stroke weights are what they say, and only the x range responds to the pane.
	 * WIDTH is the server-render default, and the first client measurement replaces it.
	 */
	const [measured, setMeasured] = useState(WIDTH)
	const frameRef = useRef<SVGSVGElement | null>(null)

	// Every date any series reported, ascending. Built from the union so a series with a gap does
	// not shorten the axis for the others.
	const dates = useMemo(() => {
		const all = new Set<string>()
		for (const s of series) for (const p of s.points) all.add(p.date)
		return [...all].sort()
	}, [series])

	const plotWidth = Math.max(120, measured - GUTTER - RIGHT_PAD)

	React.useEffect(() => {
		const frame = frameRef.current
		if (!frame || typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width
			// Rounded, so a sub-pixel resize does not churn the whole path set.
			if (width && Math.abs(width - measured) > 1) setMeasured(Math.round(width))
		})
		observer.observe(frame)
		return () => observer.disconnect()
	}, [measured])
	const height = TOP_PAD + series.length * ROW_HEIGHT + AXIS_HEIGHT

	const x = useMemo(() => {
		if (dates.length === 0) return null
		return scaleUtc()
			.domain([new Date(`${dates[0]}T00:00:00Z`), new Date(`${dates[dates.length - 1]}T00:00:00Z`)])
			.range([GUTTER, GUTTER + plotWidth])
	}, [dates, plotWidth])

	/** Pointer position to a day index, in the shared viewBox space. */
	const indexAt = useCallback(
		(clientX: number) => {
			const frame = frameRef.current
			if (!frame || dates.length === 0) return null
			const box = frame.getBoundingClientRect()
			const ratio = ((clientX - box.left) / box.width) * WIDTH
			const clamped = Math.max(GUTTER, Math.min(GUTTER + plotWidth, ratio))
			const index = Math.round(((clamped - GUTTER) / plotWidth) * (dates.length - 1))
			return Math.max(0, Math.min(dates.length - 1, index))
		},
		[dates.length, plotWidth],
	)

	/**
	 * Apply a span, if it is long enough to draw.
	 *
	 * The floor is three days because that is what the chart itself needs — it returns null below
	 * three dates, and the panel gates the whole section the same way. A two-day brush was legal
	 * and produced a window in which the timeline, its heading, its data table and the brush
	 * affordance all disappeared: the instrument removed itself, leaving no way to widen back.
	 */
	const commit = useCallback(
		(from: number, to: number) => {
			if (!onBrush || to - from < MIN_BRUSH_DAYS - 1) return
			const start = dates[from]
			const end = dates[to]
			if (start && end) onBrush(start, end)
		},
		[onBrush, dates],
	)

	const onMove = useCallback(
		(event: React.MouseEvent<SVGSVGElement>) => {
			const index = indexAt(event.clientX)
			if (index === null) return
			setHoverIndex(index)
			// Mid-drag: extend the selection rather than only moving the crosshair.
			if (brushAnchor !== null) setBrushed([Math.min(brushAnchor, index), Math.max(brushAnchor, index)])
		},
		[indexAt, brushAnchor],
	)

	if (dates.length < 3 || series.length === 0 || !x) return null

	const hoveredDate = hoverIndex !== null ? dates[hoverIndex] : null
	const revealed = pinned || hoverIndex !== null

	// What the drawing says, in words. Serves a screen reader, anyone who cannot resolve the axis
	// type, and anyone reading a screenshot — the shaded region's whole argument was previously
	// available only as pixels.
	const shapeOf = (row: Series) => {
		const real = row.points.filter((p) => p.value !== null) as Array<{ date: string; value: number }>
		if (real.length === 0) return `${row.label}: no data`
		const top = real.reduce((best, p) => (p.value > best.value ? p : best), real[0]!)
		const total = real.reduce((sum, p) => sum + p.value, 0)
		return `${row.label} (${row.source}): ${formatValue(total, row.unit, currency)} in total, `
			+ `peaking at ${formatValue(top.value, row.unit, currency)} on ${tickLabel(new Date(`${top.date}T00:00:00Z`))}`
	}

	const missed = series.flatMap((row) => {
		if (!row.shortfall) return []
		const seen = new Map(row.shortfall.points.map((p) => [p.date, p.value]))
		let gap = 0
		let worst: { date: string; ratio: number } | null = null
		for (const point of row.points) {
			if (point.value === null) continue
			const saw = seen.get(point.date)
			if (saw == null) continue
			gap += point.value - saw
			const ratio = point.value > 0 ? 1 - saw / point.value : 0
			if (!worst || ratio > worst.ratio) worst = { date: point.date, ratio }
		}
		if (gap <= 0 || !worst) return []
		return [`${row.shortfall.source} missed ${formatCount(Math.round(gap))} ${row.label.toLowerCase()} over this period; `
			+ `the gap was widest on ${tickLabel(new Date(`${worst.date}T00:00:00Z`))} at ${formatPercent(worst.ratio, 0)}.`]
	})

	const summary = `${dates.length} days from ${tickLabel(new Date(`${dates[0]}T00:00:00Z`))} to `
		+ `${tickLabel(new Date(`${dates[dates.length - 1]}T00:00:00Z`))}. `
		+ series.map(shapeOf).join('. ') + '. ' + missed.join(' ')
		+ (markers.length > 0 ? ` ${markers.length} campaign send${markers.length === 1 ? '' : 's'} marked.` : '')

	return (
		<Stack space={3}>
			<div style={frameStyle}>
				<svg
					ref={frameRef}
					viewBox={`0 0 ${measured} ${height}`}
					// The viewBox tracks the measured width, so the scale is exactly 1 and every size
					// here is a real CSS pixel. Height is fixed rather than derived from the aspect
					// ratio, so rows keep their height whatever the pane does.
					onMouseMove={onMove}
					// A selection in flight is abandoned when the pointer leaves, but nothing is left
					// drawn: a selection still on screen that never applied is a silent no-op that
					// looks like success.
					onMouseLeave={() => { setHoverIndex(null); setBrushAnchor(null); setBrushed(null) }}
					onPointerDown={(event) => {
						if (!onBrush) return
						const index = indexAt(event.clientX)
						if (index === null) return
						event.preventDefault()
						// Captured, so a drag that ends outside the chart still commits. "From the
						// campaign send to today" is the most natural gesture here and it finishes at
						// the right edge — without capture the pointer left, the anchor was dropped,
						// and nothing happened.
						event.currentTarget.setPointerCapture(event.pointerId)
						setBrushAnchor(index)
						setBrushed([index, index])
					}}
					onPointerUp={(event) => {
						if (!onBrush || brushAnchor === null) return
						if (event.currentTarget.hasPointerCapture(event.pointerId)) {
							event.currentTarget.releasePointerCapture(event.pointerId)
						}
						const index = indexAt(event.clientX) ?? hoverIndex ?? brushAnchor
						const from = Math.min(brushAnchor, index)
						const to = Math.max(brushAnchor, index)
						setBrushAnchor(null)
						setBrushed(null)
						commit(from, to)
					}}
					style={{ width: '100%', height, display: 'block', cursor: onBrush ? 'col-resize' : 'default' }}
					tabIndex={0}
					role="img"
					// The label carries the SHAPE, not just the subject. It previously said only which
					// rows existed, which is the chart's title rather than its content — and since
					// role="img" prunes every descendant, that was the entire chart for a blind
					// reader. Peaks, dates and the size of the gap are the facts the drawing conveys.
					aria-label={summary}
					onFocus={() => setHoverIndex((current) => current ?? dates.length - 1)}
					onBlur={() => setHoverIndex(null)}
					onKeyDown={(event) => {
						// The chart this replaced had arrow-key day stepping and this one did not, so
						// the newer, more prominent chart regressed against the older one.
						let next: number | null = null
						const current = hoverIndex ?? dates.length - 1
						if (event.key === 'ArrowRight') next = Math.min(current + 1, dates.length - 1)
						if (event.key === 'ArrowLeft') next = Math.max(current - 1, 0)
						if (event.key === 'Home') next = 0
						if (event.key === 'End') next = dates.length - 1
						if (event.key === 'Escape') { setHoverIndex(null); setBrushed(null); return }
						if (event.key === 'Enter' && brushed && onBrush) {
							event.preventDefault()
							commit(brushed[0], brushed[1])
							setBrushed(null)
							return
						}
						if (next === null) return
						event.preventDefault()
						setHoverIndex(next)
						// Shift extends a selection, so the brush is reachable without a pointer —
						// which matters more here than usual, since this is the tool's one
						// cross-filter and the pane is often narrow.
						if (event.shiftKey && onBrush) {
							const anchor = brushed ? brushed[0] : current
							setBrushed([Math.min(anchor, next), Math.max(anchor, next)])
						}
					}}
				>
					{series.map((row, rowIndex) => {
						const top = TOP_PAD + rowIndex * ROW_HEIGHT
						const bottom = top + ROW_HEIGHT - 18

						const values = row.points.map((p) => p.value).filter((v): v is number => v !== null)
						// Each row scales to ITSELF. That is the whole point of small multiples: no
						// shared scale means no invented correlation between rows.
						const peak = d3Max(values) ?? 0
						const y = scaleLinear().domain([0, peak || 1]).nice().range([bottom, top])

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

						const path = row.mark === 'events' ? '' : lineGen(row.points) ?? ''

						// One stem per day that had one. Width tracks the day slot so a year of data
						// stays a texture rather than a picket fence, with a floor so a single order
						// in a quarter is still findable.
						const slot = plotWidth / Math.max(1, dates.length)
						const stemWidth = Math.max(1.5, Math.min(9, slot - 1))
						const stems = row.mark === 'events'
							? row.points.filter((p) => p.value !== null && (p.value as number) > 0)
							: []
						const gap = row.shortfall ? gapGen(row.points) ?? '' : ''
						// The lossier source's own line, revealed only while reading a day.
						const shortfallLine = row.shortfall && revealed
							? lineGen(shortfallPoints.filter((p) => p.value !== null)) ?? ''
							: ''

						return (
							<g key={row.key}>
								<line x1={GUTTER} x2={GUTTER + plotWidth} y1={bottom} y2={bottom} stroke="currentColor" strokeWidth={1} opacity={0.45} />

								{/* The row names itself, in the dead strip above its own band. Small
								    multiples without in-place labels forfeit the thing they are for:
								    scanning down the stack and knowing what each band is. The label
								    used to live only in a wrapping legend whose order was not tied to
								    vertical position. */}
								{/* Inside the band, not in the gutter above it. At `top - 6` the label's
								    ascender sat four units below the PREVIOUS row's baseline and six
								    above its own — bound by proximity to the wrong band, which is the
								    one thing small multiples exist to get right. On row 0 it also ran
								    straight through the campaign marker dots. */}
								<text x={GUTTER + 4} y={top + 12} fontSize={AXIS_TYPE} fill="currentColor" opacity={0.7} fontWeight={500}>
									{row.label}
								</text>
								<text x={GUTTER + plotWidth} y={top + 12} textAnchor="end" fontSize={AXIS_TYPE} fill="currentColor" opacity={0.5}>
									{row.source}{row.complete ? '' : ' · partial'}
								</text>

								{/* The axis top is what the scale REACHES, read back off the domain.
								    Printing the raw peak beside a .nice()d scale gave three different
								    numbers: a band topping out at 2,500, a label reading 2,356, and a
								    position corresponding to neither. */}
								<text x={GUTTER - 6} y={y(y.domain()[1] as number) + 4} textAnchor="end" fontSize={AXIS_TYPE} fill="currentColor" opacity={0.7}>
									{formatValue(y.domain()[1] as number, row.unit, currency)}
								</text>
								<text x={GUTTER - 6} y={bottom + 4} textAnchor="end" fontSize={AXIS_TYPE} fill="currentColor" opacity={0.7}>0</text>

								{/* One alpha, measured, not tied to hover.
								    A previous comment claimed 0.26/0.34 cleared 3:1 and it did not —
								    computing the composite against the card gives 1.80:1 and 2.22:1 in
								    light. 0.48 gives 3.33:1 light and 4.16:1 dark, so one number serves
								    both themes. It is constant because a quantity that brightens when
								    the pointer enters the chart is jitter, not information. */}
								{gap && <path d={gap} fill="currentColor" opacity={0.48} />}

								{shortfallLine && (
									<path d={shortfallLine} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.8} />
								)}

								{stems.map((p) => {
									const cx = at(p)
									const top = y(p.value as number)
									if (!Number.isFinite(cx) || !Number.isFinite(top)) return null
									return (
										<rect
											key={p.date}
											x={cx - stemWidth / 2}
											y={top}
											width={stemWidth}
											// Floored at 1.5px: a day whose value rounds to nothing on this
											// scale still happened, and drawing it as zero height would say
											// it did not.
											height={Math.max(1.5, bottom - top)}
											fill="currentColor"
											opacity={0.75}
										/>
									)
								})}

								{path && <path
									d={path}
									fill="none"
									stroke="currentColor"
									strokeWidth={2}
									// Dashed only where the LINE's own source misses things. A row whose
									// line is complete stays solid even when it carries a blind-spot fill.
									strokeDasharray={row.complete ? undefined : '6 4'}
									opacity={row.complete ? 0.95 : 0.7}
								/>}
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
									strokeWidth={1.25}
									strokeDasharray="4 3"
									opacity={0.5}
								/>
								<circle cx={at} cy={TOP_PAD - 8} r={3} fill="currentColor" opacity={0.7} />
							</g>
						)
					})}

					{/* The selection. Drawn as two dimmed flanks rather than a tinted middle, so the
					    chosen span keeps the card's own background and stays the most legible part of
					    the chart — a tint over the data would fight the marks it is meant to frame. */}
					{/* Bounds-checked against the CURRENT dates. `brushed` holds indices, and a commit
					    changes the range underneath it — so after narrowing, indices from the old
					    window pointed past the end of the new one, `dates[i]` was undefined, and both
					    rects rendered width="NaN". */}
					{brushed && brushed[1] > brushed[0] && brushed[1] < dates.length && (
						<g aria-hidden="true">
							{/* Scrimmed toward the CARD, not with currentColor. currentColor is near-white
							    on a dark card, so the "dimmed" flanks became the brightest part of the
							    chart and the selection the darkest — the inverse of the intent, in half
							    the installs. */}
							<rect
								x={GUTTER}
								y={TOP_PAD - 8}
								width={Math.max(0, x(new Date(`${dates[brushed[0]]}T00:00:00Z`)) - GUTTER)}
								height={series.length * ROW_HEIGHT - 10}
								fill="var(--card-bg-color, #ffffff)"
								opacity={0.72}
							/>
							<rect
								x={x(new Date(`${dates[brushed[1]]}T00:00:00Z`))}
								y={TOP_PAD - 8}
								width={Math.max(0, GUTTER + plotWidth - x(new Date(`${dates[brushed[1]]}T00:00:00Z`)))}
								height={series.length * ROW_HEIGHT - 10}
								fill="var(--card-bg-color, #ffffff)"
								opacity={0.72}
							/>
						</g>
					)}

					{hoveredDate && (
						<line
							x1={x(new Date(`${hoveredDate}T00:00:00Z`))}
							x2={x(new Date(`${hoveredDate}T00:00:00Z`))}
							y1={TOP_PAD - 6}
							y2={TOP_PAD + series.length * ROW_HEIGHT - 18}
							stroke="currentColor"
							strokeWidth={1}
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
								fontSize={AXIS_TYPE}
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
					{/* The selection is confirmed where the gesture happens. The only confirmation was
					    a line above the tab strip, the full height of the panel away from the drag. */}
					{brushed && brushed[1] > brushed[0] && brushed[1] < dates.length
						? `${tickLabel(new Date(`${dates[brushed[0]]}T00:00:00Z`))} – ${tickLabel(new Date(`${dates[brushed[1]]}T00:00:00Z`))} · ${brushed[1] - brushed[0] + 1} days`
						: hoveredDate
							? tickLabel(new Date(`${hoveredDate}T00:00:00Z`))
							: 'Hover the chart to read a day'}
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
				{missed.map((sentence) => (
					// The region's argument, stated as a number. It was drawn to scale and described
					// in the abstract, so the two facts it exists to convey — how much was missed and
					// when it was worst — were available only by looking hard at a pale fill.
					<Text key={sentence} size={0} muted>{sentence}</Text>
				))}
				{series.some((row) => row.shortfall) && (
					<Text size={0} muted>Shaded: what your analytics did not see.</Text>
				)}
				{markers.length > 0 && <Text size={0} muted>Vertical rules mark campaign sends.</Text>}
				{onBrush && (
					<Text size={0} muted>
						Drag across at least three days — or hold shift and use the arrow keys, then Enter — to
						narrow every panel to that span.
					</Text>
				)}
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
