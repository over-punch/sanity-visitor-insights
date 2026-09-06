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
	/**
	 * A fixed y domain, instead of scaling the row to its own peak.
	 *
	 * Small multiples normally scale each row to itself, which is right for quantities whose
	 * absolute size is not comparable between rows. It is wrong for a proportion: a coverage row
	 * auto-scaled to its own maximum would redraw 100% at whatever the best day happened to be, so
	 * a site running at a flat 20% would show a full-height line and read as healthy.
	 */
	domain?: [number, number]
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
const ROW_HEIGHT = 92
/** Space under the last row for the shared date axis. */
const AXIS_HEIGHT = 26
/** Left gutter for each row's own y-axis labels — 7% of the width, not 52%. */
const GUTTER = 52
const RIGHT_PAD = 12
const TOP_PAD = 22
/** Type size inside the plot. A real value now that the scale is uniform. */
const AXIS_TYPE = 11
/**
 * Height reserved above each row's plot for its label, in user units.
 *
 * ROW_HEIGHT was raised by this amount plus a little when the strip was introduced. Carving it out
 * of the existing 74 left a 40px plot inside a 74px row — 34px of gutter serving 40px of data,
 * where a doubling of daily pageviews moved the line about thirteen pixels. The overlap was real;
 * paying for the fix out of the data band was not.
 *
 * Enough for AXIS_TYPE plus its descender and a little air. The plot starts below it, so a row's
 * peak can reach the top of its scale without meeting its own name.
 */
const LABEL_STRIP = 16
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
 * Map a pointer's page X to a day index.
 *
 * Extracted from the component so it can be tested: `indexAt` needs a live
 * `getBoundingClientRect`, and these tests render to static markup with no DOM — which is exactly
 * why the bug this guards against shipped. The chart's viewBox tracks the measured width, and this
 * conversion was left dividing through the 760-unit SSR default, so on a 500px pane the right third
 * of pointer travel clamped to the last day and on a 900px pane the last sixth of days could not be
 * reached at all. The crosshair did not land under the cursor and a brush did not select the span
 * that was dragged.
 *
 * @param clientX - the pointer's viewport X
 * @param left - the chart box's viewport left edge
 * @param boxWidth - the chart box's rendered CSS width; 0 or less yields null
 * @param viewBoxWidth - the width the viewBox is currently set to, in user units
 * @param plotWidth - the drawable width inside the gutters, in user units
 * @param count - how many days are plotted
 */
export function dayIndexAt(
	clientX: number,
	left: number,
	boxWidth: number,
	viewBoxWidth: number,
	plotWidth: number,
	count: number,
): number | null {
	if (count === 0 || boxWidth <= 0 || plotWidth <= 0) return null
	const ratio = ((clientX - left) / boxWidth) * viewBoxWidth
	const clamped = Math.max(GUTTER, Math.min(GUTTER + plotWidth, ratio))
	const index = Math.round(((clamped - GUTTER) / plotWidth) * (count - 1))
	return Math.max(0, Math.min(count - 1, index))
}

/** A sustained collapse in one source's coverage, as opposed to a standing shortfall. */
export interface CoverageIncident {
	/** First day of the run. */
	onset: string
	/** How many consecutive days it has lasted. */
	days: number
	/** Typical coverage before it, 0 to 1. */
	before: number
	/** Typical coverage during it, 0 to 1. */
	during: number
	/** Whether the run reaches the last measured day, i.e. it has not recovered. */
	ongoing: boolean
}

/**
 * Tell a dated incident apart from a constant shortfall.
 *
 * The summary used to give a total and a single worst day, which cannot distinguish "GA4 always
 * sees a fifth of the traffic" from "GA4 saw everything until the 24th, then almost nothing for ten
 * days" — and the second is the founding case of this entire package. The two need opposite
 * responses: one is a measurement caveat to live with, the other is a fault with a date on it.
 *
 * The method is deliberately blunt, because the input is noisy at these volumes: take each day's
 * coverage, take the median as the range's normal, and look for a run of consecutive days sitting
 * far below that normal. A median is used rather than a mean so the incident itself does not define
 * the baseline it is measured against.
 *
 * @param days - coverage per day in date order, null on days that cannot be measured
 * @param dates - the matching dates, same length and order
 */
export function findCoverageIncident(days: Array<number | null>, dates: string[]): CoverageIncident | null {
	const measured = days.filter((d): d is number => d !== null)
	// Three weeks of daily figures before this is worth attempting. Below that a "run" is as likely
	// to be a quiet fortnight as a fault, and naming a date carries more authority than the evidence.
	if (measured.length < 21) return null

	const sorted = [...measured].sort((a, b) => a - b)
	/*
	 * The 75th percentile, not the median.
	 *
	 * A median tolerates contamination only to half the sample, so once an outage covered more than
	 * half the window the median WAS the outage: the threshold dropped to half the collapsed level,
	 * the healthy days before it were never "low", and the function returned null. Detection got
	 * quieter as the fault got worse, which is the opposite of what an alarm is for. A 46-day
	 * collapse in a 90-day quarter — the default range — was silent.
	 */
	const normal = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]!
	// A source that never clears a tenth leaves no room for a fall to be detected against it. That
	// is a total shortfall, which the coverage row draws as a flat line near zero.
	if (normal <= 0.1) return null

	const threshold = normal * 0.5
	const MIN_RUN = 3
	// A run survives up to two consecutive unmeasured days. A null used to end it, and a null is
	// routine — a day with no traffic at all yields one — so a ten-day outage split into 6 and 3,
	// the longer half was reported, and the onset date named a day INSIDE the outage rather than
	// its start. That date is the one thing the reader acts on.
	const MAX_GAP = 2

	// Every candidate, longest first. The "needs a before" rule used to be applied to the single
	// longest run and then ABORT the whole search, so a range that opens mid-outage reported
	// nothing at all — including any later incident it did have.
	const runs: Array<{ start: number; end: number }> = []
	let runStart: number | null = null
	let gap = 0
	for (let i = 0; i <= days.length; i++) {
		const value = i < days.length ? days[i] : undefined
		const low = value !== null && value !== undefined && value < threshold
		const unmeasured = i < days.length && (value === null || value === undefined)

		if (low) {
			if (runStart === null) runStart = i
			gap = 0
		} else if (unmeasured && runStart !== null && gap < MAX_GAP) {
			gap += 1
		} else if (runStart !== null) {
			// The run ends at the last LOW day, not at the gap that followed it.
			runs.push({ start: runStart, end: i - gap })
			runStart = null
			gap = 0
		}
	}
	runs.sort((a, b) => (b.end - b.start) - (a.end - a.start))

	const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length

	for (const run of runs) {
		if (run.end - run.start < MIN_RUN) continue
		const during = days.slice(run.start, run.end).filter((d): d is number => d !== null)
		const before = days.slice(0, run.start).filter((d): d is number => d !== null)
		// Without a before there is nothing to call this a CHANGE from — it is the range's normal.
		if (before.length < 3 || during.length === 0) continue

		const onset = dates[run.start]
		if (!onset) continue

		const beforeMean = mean(before)
		const after = days.slice(run.end).filter((d): d is number => d !== null)
		/*
		 * "Recovered" is a claim, and it now has to be earned.
		 *
		 * It used to mean only that the run did not touch the end of the array — so a null final day,
		 * or one day back above the threshold, printed "then recovered" while coverage sat at half
		 * its old level. This is the tool's one dated alarm and it could stand itself down on no
		 * evidence. Recovery means measured days after the run, averaging back near where they were.
		 */
		const recovered = after.length >= MIN_RUN && mean(after) >= beforeMean * 0.8

		return {
			onset,
			days: run.end - run.start,
			before: beforeMean,
			during: mean(during),
			ongoing: !recovered,
		}
	}

	return null
}

export function CrossSourceTimeline({ series, markers = [], currency, onBrush }: CrossSourceTimelineProps): React.ReactElement | null {
	const [hoverIndex, setHoverIndex] = useState<number | null>(null)
	// Whether to draw the constituent sources. Hover reveals them; so does keyboard focus and the
	// explicit toggle, because a chart whose detail exists only under a pointer is unreachable on a
	// phone and to anyone navigating by keyboard.
	const [pinned, setPinned] = useState(false)
	/** Index the drag began at, or null when not dragging. */
	const [brushAnchor, setBrushAnchor] = useState<number | null>(null)
	/**
	 * The span being dragged, in day indices. Null when no drag is in flight.
	 *
	 * Deliberately NOT kept after release. Committing changes the range, which replaces the whole
	 * series underneath these indices — so a selection left drawn would be positioned against days
	 * that no longer exist, which is how it once produced NaN geometry. An earlier version of this
	 * comment claimed the selection stays drawn to confirm the gesture; it never did.
	 */
	const [brushed, setBrushed] = useState<[number, number] | null>(null)
	/** A stable id for this mounted chart, so its SVG defs cannot collide with another instance's. */
	const instanceId = React.useId().replace(/[^a-zA-Z0-9]/g, '')
	// Whether the reader arrived at this day by keyboard. Only then does the readout announce.
	//
	// The region is driven by `hoverIndex`, which a slow pointer sweep across ninety days changes
	// about ninety times — so a screen-reader user got the whole chart twice, once as the static
	// summary and once as an unthrottled stream. Keyboard stepping is the case the live region was
	// added for, and it changes one day at a time on purpose.
	const [steppedByKeyboard, setSteppedByKeyboard] = useState(false)

	/** Whether the last drag was too short to apply, so the chart can say so instead of ignoring it. */
	const [tooShort, setTooShort] = useState(false)
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
	/**
	 * The chart element, as STATE as well as a ref.
	 *
	 * A ref alone cannot drive the measuring effect. The component returns null below three dates,
	 * so on a mount with no data the ref is null when the effect runs — and with a stable dep array
	 * the effect never runs again, leaving the chart pinned at the 760 default with no path out. A
	 * callback ref makes attachment an observable event.
	 */
	const [frameNode, setFrameNode] = useState<SVGSVGElement | null>(null)
	const attachFrame = useCallback((node: SVGSVGElement | null) => {
		frameRef.current = node
		setFrameNode(node)
	}, [])

	// Every date any series reported, ascending. Built from the union so a series with a gap does
	// not shorten the axis for the others.
	const dates = useMemo(() => {
		const all = new Set<string>()
		for (const s of series) for (const p of s.points) all.add(p.date)
		return [...all].sort()
	}, [series])

	const plotWidth = Math.max(120, measured - GUTTER - RIGHT_PAD)

	// useLayoutEffect, and it measures once before the browser paints. With a plain effect the
	// first frame drew a 760-unit viewBox inside a real-width box with a fixed CSS height, and the
	// default preserveAspectRatio letterboxed it — a 400px pane rendered the whole chart at 52%
	// scale, centred in dead space, then snapped. That happened on every mount, so every tab switch
	// and every range change flashed it.
	React.useLayoutEffect(() => {
		const frame = frameNode
		if (!frame) return

		// Functional, so the effect does not depend on `measured`. Depending on it tore the
		// observer down and rebuilt it on every width change — avoidable churn, and the shape that
		// produces "ResizeObserver loop completed with undelivered notifications".
		const apply = (width: number) => {
			// Rounded, so a sub-pixel resize does not churn the whole path set. A zero width is a
			// collapsed or hidden pane and carries no information, so the last good width stands.
			if (width <= 0) return
			const next = Math.round(width)
			setMeasured((current) => (Math.abs(next - current) > 1 ? next : current))
		}

		apply(frame.getBoundingClientRect().width)
		if (typeof ResizeObserver === 'undefined') return

		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width
			if (width !== undefined) apply(width)
		})
		observer.observe(frame)
		return () => observer.disconnect()
	}, [frameNode])
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
			return dayIndexAt(clientX, box.left, box.width, measured, plotWidth, dates.length)
		},
		[dates.length, plotWidth, measured],
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
			if (!onBrush) return
			// Says so. This returned early and left nothing on screen, so the most likely mis-drag —
			// a short one — read as the chart ignoring the reader. The comment on the pointer-leave
			// handler rejects exactly this ("a silent no-op that looks like success") and then the
			// commit path did it.
			if (to - from < MIN_BRUSH_DAYS - 1) {
				// A click is not a failed drag. `to === from` means the pointer never moved — which is
				// the ordinary gesture for reading a day — and scolding it fired the refusal far more
				// often on non-gestures than on real mis-drags, training the reader to ignore the one
				// line of copy that carries a genuine one.
				setTooShort(to > from)
				return
			}
			setTooShort(false)
			const start = dates[from]
			const end = dates[to]
			if (start && end) onBrush(start, end)
		},
		[onBrush, dates],
	)

	const onMove = useCallback(
		(event: React.PointerEvent<SVGSVGElement>) => {
			const index = indexAt(event.clientX)
			if (index === null) return
			setSteppedByKeyboard(false)
			setHoverIndex(index)
			// Mid-drag: extend the selection rather than only moving the crosshair.
			if (brushAnchor !== null) {
				const from = Math.min(brushAnchor, index)
				const to = Math.max(brushAnchor, index)
				// Only when the span actually changes. A fresh array every pointer move re-rendered
				// the chart — and re-announced its live readout — on every pixel of a drag, where
				// setHoverIndex alone bails out on an unchanged index.
				setBrushed((current) => (current && current[0] === from && current[1] === to ? current : [from, to]))
			}
		},
		[indexAt, brushAnchor],
	)

	/**
	 * Which days get a date label, spread evenly from first to last.
	 *
	 * Always includes both ends. The count is driven by the measured plot width rather than fixed,
	 * so a wide pane is not left with three labels across a metre of axis.
	 *
	 * ABOVE the early return, and it must stay there. It sat below, so any render that bailed —
	 * fewer than three days, no series — called one hook fewer than the render before it, and React
	 * throws "Rendered fewer hooks than expected", taking the whole Studio pane rather than the
	 * chart. It was masked only because the panel happens to gate on the same three-day minimum,
	 * which makes this component's own documented guard dead code and the safety one caller away.
	 */
	const tickIndexes = useMemo(() => {
		if (dates.length === 0) return []
		if (dates.length === 1) return [0]
		const affordable = Math.max(2, Math.min(8, Math.floor(plotWidth / 90)))
		const step = (dates.length - 1) / (affordable - 1)
		const indexes = Array.from({ length: affordable }, (_, i) => Math.round(i * step))
		// Deduped: a short range can round two slots onto the same day, which would draw one label
		// on top of another and give the axis two identical ends.
		return [...new Set(indexes)]
	}, [dates.length, plotWidth])

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

		// `role="img"` prunes the descendants, so this sentence IS the chart for a screen reader —
		// it has to describe what is actually drawn. An event row draws stems on the days something
		// happened, so describing it as a shape "peaking" somewhere asserted a curve that does not
		// exist, and on an all-zero row it read "peaking at $0" beside a row drawing nothing.
		if (row.mark === 'events') {
			const active = real.filter((p) => p.value !== 0)
			if (active.length === 0) {
				return `${row.label} (${row.source}): nothing on any of the ${real.length} days measured`
			}
			return `${row.label} (${row.source}): ${formatValue(total, row.unit, currency)} across `
				+ `${active.length} of ${real.length} days, the largest ${formatValue(top.value, row.unit, currency)} `
				+ `on ${tickLabel(new Date(`${top.date}T00:00:00Z`))}`
		}

		return `${row.label} (${row.source}): ${formatValue(total, row.unit, currency)} in total, `
			+ `peaking at ${formatValue(top.value, row.unit, currency)} on ${tickLabel(new Date(`${top.date}T00:00:00Z`))}`
	}

	const missed = series.flatMap((row) => {
		if (!row.shortfall) return []
		const seen = new Map(row.shortfall.points.map((p) => [p.date, p.value]))
		let gap = 0
		let excess = 0
		let worst: { date: string; ratio: number } | null = null

		// "Widest" needs a volume floor, because a ratio on an unbounded denominator is won by the
		// quietest day: one Vercel pageview and no GA4 scores a perfect 1.0 and beats a real
		// incident. At these volumes low-traffic days are routine, so without this the headline
		// sentence names a trivial Sunday most of the time. A tenth of the busiest day is the bar.
		const busiest = row.points.reduce((best, p) => Math.max(best, p.value ?? 0), 0)
		const floor = Math.max(1, busiest * 0.1)

		for (const point of row.points) {
			if (point.value === null) continue
			const saw = seen.get(point.date)
			if (saw == null) continue
			const difference = point.value - saw
			// Signed sums kept apart. Adding them let days where GA4 counted MORE — a prefetch, a
			// double-firing tag — quietly cancel days where it counted less, so a site with both
			// problems reported no gap at all.
			if (difference >= 0) gap += difference
			else excess += -difference
			const ratio = point.value > 0 ? 1 - saw / point.value : 0
			if (point.value >= floor && (!worst || ratio > worst.ratio)) worst = { date: point.date, ratio }
		}

		// Over-counting is its own finding, not the absence of one. It used to fall through the
		// `gap <= 0` guard and print nothing, so the failure mode with the loudest cause — a tag
		// installed twice — was the one the chart stayed silent about.
		// Both faults, separately, and never their difference. Printing `excess - gap` re-created
		// exactly the cancellation the accumulation above was split up to avoid: 1,100 over-counted
		// against 1,000 under-counted reported as "100 more". Returning early on it also suppressed
		// the under-count sentence — this tool's central figure — whenever a second, unrelated
		// defect happened to be larger.
		const sentences: string[] = []
		if (excess > 0) {
			sentences.push(`${row.shortfall.source} counted ${formatValue(Math.round(excess), row.unit, currency)} more `
				+ `${row.label.toLowerCase()} than ${row.source} on some days, which usually means a tag firing twice `
				+ `rather than extra traffic.`)
		}
		if (gap <= 0) return sentences

		// An incident, if there is one. Stated BEFORE the total, because "coverage fell on the 24th
		// and has not recovered" is a different kind of fact from "the gap was this big" — the first
		// is a fault with a date, the second is a quantity to caveat.
		const coverageByDay = row.points.map((point) => {
			if (point.value === null || point.value <= 0) return null
			const saw = seen.get(point.date)
			return saw == null ? null : saw / point.value
		})
		const incident = findCoverageIncident(coverageByDay, row.points.map((p) => p.date))
		if (incident) {
			sentences.push(
				`${row.shortfall.source} coverage fell from about ${formatPercent(incident.before, 0)} to `
				+ `${formatPercent(incident.during, 0)} on ${tickLabel(new Date(`${incident.onset}T00:00:00Z`))}`
				+ (incident.ongoing
					? `, and has stayed there for ${incident.days} days. That is a change on a date, not a standing shortfall — something altered on or around then.`
					: ` for ${incident.days} days, then recovered.`),
			)
		}

		// The total is stated whether or not a worst day can be named. It used to be discarded when
		// `worst` was null — which the volume floor made reachable, since a single big spike raises
		// the bar for every other day — so the tool's headline figure disappeared because the
		// SUPERLATIVE could not be computed. The floor was there to fix which day gets named, not
		// whether the total gets said.
		//
		// The unit, too: this built every sentence with formatCount, so a revenue shortfall read
		// "Sanity missed 1,234 revenue".
		const total = `${row.shortfall.source} missed ${formatValue(Math.round(gap), row.unit, currency)} `
			+ `${row.label.toLowerCase()} over this period`
		// Only a positive ratio is a gap. `worst` takes the maximum among floor-clearing days, and
		// when every one of those was over-counted that maximum is negative — "the gap was widest at
		// −24%", which is not a gap.
		sentences.push(worst && worst.ratio > 0
			? `${total}; the gap was widest on ${tickLabel(new Date(`${worst.date}T00:00:00Z`))} at ${formatPercent(worst.ratio, 0)}.`
			: `${total}.`)
		return sentences
	})

	const summary = `${dates.length} days from ${tickLabel(new Date(`${dates[0]}T00:00:00Z`))} to `
		+ `${tickLabel(new Date(`${dates[dates.length - 1]}T00:00:00Z`))}. `
		+ series.map(shapeOf).join('. ') + '. ' + missed.join(' ')
		+ (markers.length > 0 ? ` ${markers.length} campaign send${markers.length === 1 ? '' : 's'} marked.` : '')

	return (
		<Stack space={3}>
			<div style={frameStyle}>
				<svg
					ref={attachFrame}
					viewBox={`0 0 ${measured} ${height}`}
					// The viewBox tracks the measured width, so the scale is exactly 1 and every size
					// here is a real CSS pixel. Height is fixed rather than derived from the aspect
					// ratio, so rows keep their height whatever the pane does.
					// onPointerMove, not onMouseMove. The anchor and the commit were already pointer
					// events but the EXTENSION was not, and touch and pen send no compatibility
					// mousemove stream during a drag — so `brushed` stayed at [i, i], commit saw a
					// zero-length span, and the gesture did nothing while the legend advertised it.
					onPointerMove={onMove}
					// A selection in flight is abandoned when the pointer leaves, but nothing is left
					// drawn: a selection still on screen that never applied is a silent no-op that
					// looks like success.
					// tooShort is NOT cleared here. The message renders below the chart, so a reader who
					// mis-drags and then moves down to read the explanation crosses the boundary and
					// used to destroy it on the way. It clears on the next drag instead.
					onPointerLeave={() => { setHoverIndex(null); setBrushAnchor(null); setBrushed(null) }}
					onPointerDown={(event) => {
						if (!onBrush) return
						setTooShort(false)
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
						setSteppedByKeyboard(true)
						setHoverIndex(next)
						// Shift extends a selection, so the brush is reachable without a pointer —
						// which matters more here than usual, since this is the tool's one
						// cross-filter and the pane is often narrow.
						if (event.shiftKey && onBrush) {
							// A FIXED anchor, held in its own state. Re-reading it as `brushed[0]` — the
							// minimum — meant extending leftward moved both ends together: [88,89] became
							// [87,88] became [86,87], stuck at two days forever. Since focus seeds the
							// cursor at the last day, shift+ArrowLeft is the natural keyboard gesture, so
							// the only cross-filter in the tool always failed and always scolded.
							const anchor = brushAnchor ?? current
							if (brushAnchor === null) setBrushAnchor(current)
							setBrushed([Math.min(anchor, next), Math.max(anchor, next)])
						}
					}}
				>
					{/* A rule at every date label, behind the data.
					    Without them the only way to answer "which day is this peak" was to hold a
					    pointer on it: three labels sat 38px below the last baseline with nothing
					    joining them to the rows, so dating a feature meant tracing an unruled column by
					    eye. Faint enough to stay behind the marks, present enough to read against. */}
					{tickIndexes.map((index) => {
						const date = dates[index]
						if (!date) return null
						const at = x(new Date(`${date}T00:00:00Z`))
						if (!Number.isFinite(at)) return null
						return (
							<line
								key={`grid-${date}`}
								x1={at}
								x2={at}
								y1={TOP_PAD}
								y2={TOP_PAD + series.length * ROW_HEIGHT - 18}
								stroke="currentColor"
								strokeWidth={1}
								opacity={0.08}
							/>
						)
					})}

					{series.map((row, rowIndex) => {
						const top = TOP_PAD + rowIndex * ROW_HEIGHT
						const bottom = top + ROW_HEIGHT - 18
						// The row label gets its own strip above the plot rather than sharing it. The
						// label sat at `top + 12` with the scale's maximum AT `top`, so by construction
						// the tallest point of every row — the peak day, the thing the row exists to
						// show — passed under its own name, along with the axis-max figure at `top + 4`.
						// Roughly a third of each band was type over data.
						const plotTop = top + LABEL_STRIP

						const values = row.points.map((p) => p.value).filter((v): v is number => v !== null)
						// Each row scales to ITSELF. That is the whole point of small multiples: no
						// shared scale means no invented correlation between rows.
						const peak = d3Max(values) ?? 0
						// The floor drops below zero when the data does. Clipping each row to its band was
						// right, but the domain still started at 0, so a refund was positioned below the
						// baseline and therefore outside the clip — it went from bleeding into the next
						// row to not being drawn at all, while `shapeOf` still counted it in the row's
						// spoken total. The clip moved that bug rather than fixing it.
						const lowest = Math.min(0, ...values)
						const y = row.domain
							? scaleLinear().domain(row.domain).range([bottom, plotTop])
							: scaleLinear().domain([lowest, peak || 1]).nice().range([bottom, plotTop])
						// Where zero sits once the domain may be negative — the baseline rule and the
						// stems both hang off this rather than off the bottom of the band.
						const zeroY = y(0)

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
						// The pitch is between ENDPOINTS, so it divides by the number of gaps, not the
						// number of days. The inter-stem gutter only exists when there is room for
						// one: at 365 days in a narrow pane the pitch is under a pixel, `pitch - 1`
						// goes negative, and the 1.5 floor then drew every stem wider than its own
						// day — adjacent days merged into a solid slab that overstated each one.
						const pitch = plotWidth / Math.max(1, dates.length - 1)
						const stemWidth = Math.max(1, Math.min(9, pitch > 2 ? pitch - 1 : pitch))
						// Non-zero, either sign. Filtering on `> 0` dropped refunds and chargebacks from
						// the drawing while `shapeOf` still counted them in the total, so the picture
						// and its own description disagreed.
						const stems = row.mark === 'events'
							? row.points.filter((p) => p.value !== null && (p.value as number) !== 0)
							: []

						// Days measured as zero, marked on the baseline. Drawing nothing for them made a
						// day with no sales identical to a day Sanity never reported — the one
						// distinction this package exists to keep (see the header of Figure.tsx). The
						// tick is at the axis, so it reads as "measured, and it was nothing".
						// Only where they can read as SEPARATE marks. At ninety days in a narrow pane the
						// pitch is under four pixels, so eighty-odd abutting ticks merge into a slightly
						// darker baseline — a thicker axis, not a row of measurements — and now that the
						// series is a complete calendar that is the normal case rather than the rare one.
						// Below the threshold the row being drawn at all is what says it was measured.
						const zeroes = row.mark === 'events' && pitch >= 6
							? row.points.filter((p) => p.value === 0)
							: []
						const gap = row.shortfall ? gapGen(row.points) ?? '' : ''
						// The lossier source's own line, revealed only while reading a day.
						// The SAME generator, nulls left in, so `.defined()` breaks the line where GA4
						// reported nothing. Filtering them out first joined the surviving points into a
						// continuous stroke — so a GA4 outage, the single event this chart was built to
						// expose, was drawn as a smooth line straight through the missing days. The
						// shaded region beneath already broke correctly, so the fill and the line
						// disagreed about the same days and the one on top was the one that lied.
						const shortfallLine = row.shortfall && revealed ? lineGen(shortfallPoints) ?? '' : ''

						// Every mark is clipped to its own band.
						//
						// scaleLinear does not clamp, so two states the chart was recently taught to
						// draw escape their row: GA4 counting MORE than the complete source puts the
						// fill above the plot top and through the label strip into the row above, and a
						// refund puts a stem below the baseline and through the gutter into the row
						// below, where either reads as that row's data.
						// Namespaced per mounted chart. `row-clip-${rowIndex}` is document-global, so two
						// instances — a split pane, or this panel beside anything reusing the scheme —
						// both define `row-clip-0`, and every colliding row resolves to whichever was
						// parsed first, whose plot width came from a differently sized pane. Silent
						// mis-clipping, no error.
						const clipId = `${instanceId}-row-${rowIndex}`

						return (
							<g key={row.key}>
								<defs>
									<clipPath id={clipId}>
										<rect x={GUTTER} y={plotTop} width={plotWidth} height={Math.max(1, bottom - plotTop)} />
									</clipPath>
								</defs>
								<line x1={GUTTER} x2={GUTTER + plotWidth} y1={zeroY} y2={zeroY} stroke="currentColor" strokeWidth={1} opacity={0.45} />

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
								<text x={GUTTER + 4} y={top + 11} fontSize={AXIS_TYPE} fill="currentColor" opacity={0.85} fontWeight={500}>
									{row.label}
								</text>
								{/* 0.5 put 11px type at about 3.9:1 on a white card, under the 4.5:1 floor for
						    text this size. The fill's alpha was measured and documented; the type's
						    was not. 0.72 clears it in both themes. */}
						<text x={GUTTER + plotWidth} y={top + 11} textAnchor="end" fontSize={AXIS_TYPE} fill="currentColor" opacity={0.72}>
									{row.source}{row.complete ? '' : ' · partial'}
								</text>

								{/* The axis top is what the scale REACHES, read back off the domain.
								    Printing the raw peak beside a .nice()d scale gave three different
								    numbers: a band topping out at 2,500, a label reading 2,356, and a
								    position corresponding to neither. */}
								<text x={GUTTER - 6} y={y(y.domain()[1] as number) + 4} textAnchor="end" fontSize={AXIS_TYPE} fill="currentColor" opacity={0.7}>
									{formatValue(y.domain()[1] as number, row.unit, currency)}
								</text>
								{/* Formatted, like the top of the same axis. A literal "0" sat under "$800.00"
						    or "43.0%" — the two ends of one axis written in different units. */}
						<text x={GUTTER - 6} y={bottom + 4} textAnchor="end" fontSize={AXIS_TYPE} fill="currentColor" opacity={0.7}>
							{formatValue(0, row.unit, currency)}
						</text>

								{/* One alpha, measured, not tied to hover.
								    A previous comment claimed 0.26/0.34 cleared 3:1 and it did not —
								    computing the composite against the card gives 1.80:1 and 2.22:1 in
								    light. 0.48 gives 3.33:1 light and 4.16:1 dark, so one number serves
								    both themes. It is constant because a quantity that brightens when
								    the pointer enters the chart is jitter, not information. */}
								<g clipPath={`url(#${clipId})`}>
								{gap && <path d={gap} fill="currentColor" opacity={0.48} />}

								{shortfallLine && (
									<path d={shortfallLine} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.8} />
								)}

								{zeroes.map((p) => {
									const cx = at(p)
									if (!Number.isFinite(cx)) return null
									return (
										<rect
											key={`zero-${p.date}`}
											x={Math.max(GUTTER, Math.min(GUTTER + plotWidth - stemWidth, cx - stemWidth / 2))}
											// Above the baseline, taller than it, and darker. At 1px and 0.3 opacity
											// sitting ON a rule drawn at 0.45, the distinction this exists to keep
											// was encoded below the baseline's own visibility.
											y={zeroY - 3}
											width={stemWidth}
											height={3}
											fill="currentColor"
											opacity={0.55}
										/>
									)
								})}

								{stems.map((p) => {
									const cx = at(p)
									// Not `top`: that is the row band's origin, four lines up in the same scope.
									const headY = y(p.value as number)
									if (!Number.isFinite(cx) || !Number.isFinite(headY)) return null
									return (
										<rect
											key={p.date}
											// Clamped to the plot. The first and last day sit exactly on the
											// gutter edges, so a centred stem hung up to half its width outside
											// them — the first one into the y-axis label column.
											x={Math.max(GUTTER, Math.min(GUTTER + plotWidth - stemWidth, cx - stemWidth / 2))}
											y={Math.min(headY, zeroY)}
											width={stemWidth}
											// Floored at 1.5px: a day whose value rounds to nothing on this
											// scale still happened, and drawing it as zero height would say
											// it did not.
											height={Math.max(1.5, Math.abs(zeroY - headY))}
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

					{/* The shared date axis, once, at the bottom.
					    As many ticks as the measured width affords — it was fixed at three regardless,
					    so a 1400px pane got the same three labels as a 400px one, and the one thing
					    measuring the chart makes cheap went unused. ~90px per label keeps them from
					    touching at the longest label this formatter produces. */}
					{tickIndexes.map((index, position) => {
						const date = dates[index]
						if (!date) return null
						return (
							<text
								key={date}
								x={x(new Date(`${date}T00:00:00Z`))}
								y={height - 6}
								textAnchor={position === 0 ? 'start' : position === tickIndexes.length - 1 ? 'end' : 'middle'}
								fontSize={AXIS_TYPE}
								fill="currentColor"
								opacity={0.72}
							>
								{tickLabel(new Date(`${date}T00:00:00Z`))}
							</text>
						)
					})}
				</svg>
			</div>

			{/* The readout. Every series at the hovered date, so the co-movement question is answered
			    in numbers as well as in shape. */}
			<div style={readoutRow} aria-live={steppedByKeyboard ? 'polite' : 'off'}>
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
						{/* The glyph has to match the mark. A row drawn as stems was legended with a
						    solid rule, which is the legend describing a chart that is not there. */}
						<span aria-hidden="true">{row.mark === 'events' ? '▮▮▮' : row.complete ? '───' : '╌╌╌'}</span> {row.label} ({row.source})
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
					// The refusal replaces the instruction rather than sitting beside it, and it is a
					// live region: the reader has just dragged and is looking at the chart, not at the
					// small print under it.
					<Text size={0} muted={!tooShort} aria-live="polite">
						{tooShort
							? `That span was too short to apply — the chart needs at least ${MIN_BRUSH_DAYS} days. Drag a little wider.`
							: 'Drag across at least three days — or hold shift and use the arrow keys, then Enter — to narrow every panel to that span.'}
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
