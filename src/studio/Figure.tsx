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
import { Badge, Box, Card, Flex, Heading, Stack, Text, Tooltip } from '@liiift-studio/sanity-ui-compat'
import { SERIES, mark } from './palette'
import type { MetricValue, UnavailableReason } from '../types'

/** Human-readable explanation for each unavailable reason. */
const REASON_TEXT: Record<UnavailableReason, string> = {
	not_instrumented: 'Not tracked on this site',
	before_cutover: 'Not tracked during this period',
	suppressed: 'Withheld by GA4 for privacy',
	outage: 'Not recorded during part of this period',
	source_error: 'Source did not respond',
	not_applicable: 'Does not apply to this site',
	// Its own reason, because it was borrowing not_applicable — so a figure that is temporarily
	// missing rendered "Does not apply to this site. This site's API route predates this figure."
	// Two flatly contradictory sentences, and a hurried reader takes the first: this foundry has no
	// revenue. That is the mistake the top of this file exists to forbid, one layer up.
	route_outdated: 'Not available from this site yet',
}

/**
 * One locale for every number the tool prints.
 *
 * Counts were hard-coded to en-GB while money passed `undefined` and took the viewer's locale, so
 * on a non-en-GB Studio a single table row read "1,234" sessions beside "1.234,00 $" — two
 * separator conventions in the same row. Whichever convention is chosen, it has to be the same one
 * on both sides of a comparison.
 */
const LOCALE = 'en-GB'

/** Format a number with thousands separators. */
export function formatCount(value: number): string {
	return new Intl.NumberFormat(LOCALE).format(Math.round(value))
}

/** Format a 0–1 ratio as a percentage. */
export function formatPercent(ratio: number, digits = 0): string {
	return `${(ratio * 100).toFixed(digits)}%`
}

/** Props for MetricFigure. */
/** Format a money value in the site's currency, falling back to a plain number. */
export function formatMoney(value: number, currency: string | null, fractionDigits: 0 | 2 = 0): string {
	if (!currency) return formatCount(Math.round(value))
	try {
		return new Intl.NumberFormat(LOCALE, {
			style: 'currency',
			currency,
			// One precision for the whole column, chosen by the caller, not by each value's own size.
			// Switching at 1,000 put "$850.00" and "$1,200" in adjacent rows, and printed an axis
			// reading "$1,000" over a baseline reading "$0.00" — the mismatch the timeline's own
			// comment claims to have fixed by routing both ends through this function.
			maximumFractionDigits: fractionDigits,
			minimumFractionDigits: fractionDigits,
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
/**
 * How large a baseline must be before a percentage change means anything.
 *
 * Twenty-five. At a foundry's volumes the headline cards routinely compare single digits: seven
 * orders against four rendered "↑ +75%" in the largest type on the default tab, where one order
 * moves it twenty-five points. The server layer refuses far better-supported claims than that —
 * it will not rank a typeface on 28 views, and it withholds a funnel rate under a denominator of
 * 30 — while this component had no floor at all and reintroduced the claim in the presentation.
 *
 * Below the floor the figures are still shown; only the PERCENTAGE is withheld. "7 orders, was 4"
 * is the whole fact and is not improved by a ratio.
 */
export const MIN_DELTA_BASE = 25

export function Delta({ current, previous, riseIsGood = true, unit = 'count' }: DeltaProps): React.ReactElement | null {
	// isFinite, not a null check. An older API route sends undefined for a field it does not know
	// about, and a NaN can reach here from a division the server got wrong — both pass `!== null`
	// and render "NaN%" beside a confident arrow.
	if (!Number.isFinite(current as number) || !Number.isFinite(previous as number)) return null
	const now = current as number
	const before = previous as number

	const absolute = now - before

	// Flat means "rounds to nothing at the precision this prints", not "identical to the last bit".
	//
	// Only an exact zero counted as flat, so a percent move of 0.04 points printed "↑ +0.0 pts" and
	// a count move of 2 on 1,000 printed "↑ 0%" — an arrow and a direction attached to a magnitude
	// of zero, which is a claim the figure has already rounded away. It fires on the Acquisition
	// share cards, whose inputs are floats.
	const roundsToNothing = unit === 'percent'
		? Math.abs(absolute) < 0.05
		: before !== 0 && Math.abs(absolute / Math.abs(before)) < 0.005
	if (absolute === 0 || roundsToNothing) {
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

	// Too small a baseline for a ratio to mean anything — see MIN_DELTA_BASE. Placed AFTER the
	// zero-baseline case, which has its own wording: a first-ever order is "new", not "was 0".
	// The DIRECTION stays, and stays true; only the percentage is withheld, because at these counts
	// the percentage is the part that misleads. Counts only — a percentage-point move on a rate
	// carries its own denominator, which this component cannot see.
	const tooFewToRate = change !== null && unit !== 'percent' && Math.abs(before) < MIN_DELTA_BASE

	const magnitude = change === null
		? (rising ? 'new' : 'gone')
		: tooFewToRate
		? ''
		: unit === 'percent'
			// Percentage points, not a percentage of a percentage: a consent rate moving 40% → 44%
			// rose by 4 points, and calling that "+10%" is a different and confusing claim.
			? `${rising ? '+' : ''}${absolute.toFixed(1)} pts`
			: `${rising ? '+' : ''}${formatPercent(change, 0)}`

	return (
		// The baseline is printed, not hidden in a `title`. At seven orders a quarter an 18% move
		// might be one order, so "from 6" is the fact and the percentage is the decoration — and a
		// title attribute is invisible on touch, in a screenshot, and to anyone who does not hover.
		<span style={deltaStyle(tone)}>
			<span aria-hidden="true">{arrow}</span>
			{' '}
			{magnitude}
			<span style={baselineStyle}> from {baseline}</span>
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
	// Both directions read at the same strength. A good move used to be set at 70% opacity while a
	// bad one was full weight with a rule under it — so a foundry's best month visually receded,
	// which is backwards for the question the figure exists to answer. Direction is carried by the
	// arrow and the words; the rule now marks a bad move without demoting a good one.
	return {
		fontFamily: 'inherit',
		fontSize: '0.8em',
		fontWeight: 500,
		opacity: tone === 'flat' ? 0.55 : 0.9,
		color: 'currentColor',
		whiteSpace: 'nowrap',
		borderBottom: tone === 'bad' ? '1px solid currentColor' : 'none',
	}
}

/** The previous-period figure, quieter than the change but present. */
const baselineStyle: React.CSSProperties = { opacity: 0.7, fontWeight: 400 }

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
		// Guarded: the route can be newer than the Studio and send a reason this build has never
		// heard of, which rendered the word "undefined" to the reader.
		const reason = REASON_TEXT[metric.reason] ?? 'No figure available'
		const detail = metric.detail ? `${reason}. ${metric.detail}` : reason

		return (
			// The reason travels as REAL TEXT in a visually-hidden span, not as an aria-label and not
			// only in a tooltip.
			//
			// `aria-label` on a <Text> is silently dropped: it renders a bare <div>, whose role is
			// `generic`, on which aria-label is prohibited by ARIA and ignored by every major
			// browser. The em dash beside it is aria-hidden. So an unavailable metric announced as
			// an EMPTY NODE — a blank cell — which is exactly the "absent must never look like a
			// measured zero" invariant this whole type exists to enforce, inverted for anyone not
			// looking at the screen. The tooltip was the only other route and it hangs off a
			// non-focusable element, so it was pointer-only too.
			//
			// Delta already does this correctly; this is that pattern applied.
			<Tooltip content={<Box padding={2}><Text size={1}>{detail}</Text></Box>} portal>
				<Text size={size} muted>
					<span aria-hidden="true">—</span>
					<span style={visuallyHidden}>{label}: unavailable. {detail}</span>
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
				<Text size={size}>
					{formatted}
					<span style={visuallyHidden}>, partial. {metric.note}</span>
				</Text>
				<Badge tone="caution" fontSize={0}>Partial</Badge>
			</Stack>
		)
	}

	if (metric.status === 'estimated') {
		// Marked as inferred at every level: a tilde on the number, the interval beneath, a badge,
		// and the basis in the accessible name. Adding the variant to the union was not enough on
		// its own — this branch did not exist at first, so an estimate fell through to the plain
		// return below and rendered as a measured figure, which is the one thing the variant was
		// introduced to make impossible.
		const range = unit === 'percent'
			? `${metric.low.toFixed(1)}% to ${metric.high.toFixed(1)}%`
			: `${formatCount(metric.low)} to ${formatCount(metric.high)}`

		return (
			<Stack space={2}>
				<Text size={size}>
					<span aria-hidden="true">~</span>{formatted}
					<span style={visuallyHidden}>estimated, between {range}. {metric.basis}</span>
				</Text>
				<Text size={0} muted>{range}</Text>
				<Badge tone="primary" fontSize={0}>Estimated</Badge>
			</Stack>
		)
	}

	if (metric.status !== 'ok') {
		// Exhaustiveness guard. `estimated` was added to the union and rendered as a measurement
		// for exactly as long as it took to notice; this makes the compiler refuse the next one.
		const unhandled: never = metric
		void unhandled
	}

	return <Text size={size}>{formatted}</Text>
}

/** Props for ComparisonBar. */
export interface ComparisonBarProps {
	label: string
	metric: MetricValue
	/** Largest value across the sibling bars, used to scale width. */
	max: number
	/**
	 * What full width means, named.
	 *
	 * A ComparisonBar scales to the largest sibling, so a full bar means only "biggest of these" —
	 * and unlike the other two bar idioms, which print their share and their total, this one said
	 * nothing at all. There was a `tone` prop instead, which both call sites passed different
	 * values to and which the component destructured and never used.
	 */
	outOf?: string
}

/**
 * A horizontal bar with its value printed alongside.
 *
 * Deliberately CSS rather than a charting library: these panels compare and rank a handful of
 * values, which a labelled bar does as well as a chart while avoiding a large dependency in the
 * Studio bundle and the theme-token bridging that a chart library would need for light and dark.
 */
export function ComparisonBar({ label, metric, max, outOf }: ComparisonBarProps): React.ReactElement {
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
				<div aria-hidden="true" style={barTrack}>
					<div style={{ ...barFill, width: `${width}%` }} />
				</div>
			)}
			{outOf && <Text size={0} muted>{outOf}</Text>}
		</Stack>
	)
}

/** Props for ChartData. */
export interface ChartDataProps<Row> {
	/** What the disclosure is called. Names the chart it belongs to. */
	label: string
	rows: Row[]
	columns: Array<SortColumn<Row>>
	rowKey: (row: Row) => string
	exportName?: string
	/** A line above the table, for anything a column header cannot carry. */
	note?: string
	/** Which column to filter on, if the table should offer a filter box. */
	filterOn?: (row: Row) => string
}

/**
 * The figures behind a chart, as a table, collapsed by default.
 *
 * A chart is a picture of the data and not the data. Every other panel here renders a table for
 * exactly that reason — the file header used to say so, and it stopped being true the moment the
 * charts landed, leaving two time series with no equivalent anywhere in the tool.
 *
 * One disclosure serves four readers at once: someone using a screen reader, for whom an SVG under
 * `role="img"` is a single opaque node; someone navigating by keyboard; someone who cannot resolve
 * axis type at any size; and anyone who wants these numbers in a spreadsheet, since the table
 * brings sorting and CSV copy with it. Collapsed, so it costs a sighted reader one line.
 */
export function ChartData<Row>({ label, rows, columns, rowKey, exportName, note, filterOn }: ChartDataProps<Row>): React.ReactElement | null {
	if (rows.length === 0) return null

	return (
		<details style={disclosureBlock}>
			<summary style={disclosureSummary}>{label}</summary>
			<div style={{ marginTop: 10 }}>
				{note && <Text size={0} muted style={{ marginBottom: 8, display: 'block' }}>{note}</Text>}
				<SortableTable<Row>
					caption={label}
					rows={rows}
					columns={columns}
					rowKey={rowKey}
					exportName={exportName}
					filterOn={filterOn}
				/>
			</div>
		</details>
	)
}

/** The disclosure wrapper for a chart's figures. */
const disclosureBlock: React.CSSProperties = { width: '100%' }

/** Its control. Underlined so it reads as actionable, like the caveat disclosure. */
const disclosureSummary: React.CSSProperties = {
	cursor: 'pointer',
	font: 'inherit',
	fontSize: '0.85em',
	opacity: 0.75,
	textDecoration: 'underline',
	textUnderlineOffset: 3,
	width: 'fit-content',
}

/** One bar of a proportion chart. */
export interface ProportionBar {
	key: string
	label: string
	sublabel?: string
	value: number
}

/** Props for ProportionChart. */
export interface ProportionChartProps {
	bars: ProportionBar[]
	/** How to write each value out. */
	format: (value: number) => string
	/** What the bars sum to, named — a share is meaningless without its denominator stated. */
	totalLabel: string
}

/**
 * A ranked part-to-whole bar chart.
 *
 * For a breakdown whose rows sum to something meaningful — licence revenue by tier, say. Each bar
 * carries its share of the total AND its absolute value, because a share alone hides that the
 * leading row might be two orders, and an absolute alone hides that it is most of the business.
 *
 * Bars scale against the SUM rather than against the largest row, so the widths read as shares of
 * the whole. Scaling to the max would make the top row full-width whatever it was worth, which is
 * the same misreading the funnel avoids by anchoring to its entry step.
 */
export function ProportionChart({ bars, format, totalLabel }: ProportionChartProps): React.ReactElement | null {
	if (bars.length === 0) return null

	const total = bars.reduce((sum, bar) => sum + bar.value, 0)
	if (total <= 0) return null

	const ordered = [...bars].sort((a, b) => b.value - a.value)

	return (
		<Stack space={2}>
			{ordered.map((bar) => {
				const share = bar.value / total
				return (
					<Stack space={1} key={bar.key}>
						<div style={barHeader}>
							<Text size={1} weight="medium">
								{bar.label}
								{bar.sublabel && <Text size={0} muted as="span">{' '}· {bar.sublabel}</Text>}
							</Text>
							<Text size={1}>
								{format(bar.value)}
								<Text size={0} muted as="span">{' '}({formatPercent(share, 0)})</Text>
							</Text>
						</div>
						<div aria-hidden="true" style={barTrack}>
							<div style={{ ...barFill, width: `${Math.max(1, share * 100)}%` }} />
						</div>
					</Stack>
				)
			})}
			<Text size={0} muted>{totalLabel}: {format(total)}</Text>
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
 * The smallest denominator a step-to-step rate may be computed on.
 *
 * Thirty. Below it one extra visitor moves the printed percentage by more than three points, so the
 * figure describes the arrival of a single person rather than the behaviour of a group — and at
 * these foundries' volumes the lower rungs of a funnel sit well under it. The count beside it is
 * still shown, because how many people reached a step is a fact at any size; it is the ratio that
 * needs a population.
 */
const MIN_RATE_DENOMINATOR = 30

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
							<div style={funnelGap}>
								{/* Drawn on the SAME RAIL as the stage bars, and that is the whole point.
								
								    This previously had a rail of its own at `width: 38%` with the fill a
								    percentage OF THAT RAIL — so a drop-off of half your entrants rendered
								    at 19% of the width a 50% stage bar occupies, understated by a factor
								    of 2.6, beneath a comment claiming the two shared a scale. The test
								    asserted `width: 75%` for a 750-of-1000 loss and passed, because the
								    fill really was 75% of its own rail: it checked the arithmetic and
								    never the relationship.
								
								    Full width, right-aligned, same 100% as every rung above and below. */}
								{measurement === 'sequence' && delta > 0 && entry > 0 && (
									<div aria-hidden="true" style={{ ...barTrack, height: 6, flex: 1 }}>
										<div
											style={{
												marginLeft: 'auto',
												height: '100%',
												borderRadius: 2,
												background: mark('bar.lost'),
												width: `${Math.max(1, Math.min(1, delta / entry) * 100)}%`,
											}}
										/>
									</div>
								)}
								{/* NOT inside the aria-hidden. The whole gap block used to be hidden, so a
								    screen-reader user got five stage counts and nothing about drop-off at
								    all — including the warning that the gaps are not drop-offs under the
								    fallback. Only the bar is decoration; the sentence is the finding. */}
								<Text size={0} muted>{gapLabel(delta, measurement, entry)}</Text>
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

							<div aria-hidden="true" style={{ ...barTrack, height: 10 }}>
								<div style={{ ...barFill, width: `${width}%` }} />
							</div>

							{/* Both ratios where they differ — the panel used to print only the
							    step-to-step one, and a reader comparing two adjacent small
							    percentages had no way to see how narrow the funnel had already
							    become. On stage two the previous step IS entry, so printing both
							    read as "100.0% of landed · 500.0% of landed". */}
							{/*
							  * A rate is printed only where its denominator can carry one.
							  *
							  * This was the last figure in the tool still stating a small-sample number
							  * with full authority. At seven orders a quarter and a fifth of traffic
							  * captured, the lower rungs hold single digits — so "33.3% of began
							  * checkout" was one visitor out of three, drawn to a decimal place and
							  * sitting in the same type as a rate computed on hundreds. One more sale
							  * moves it thirty points.
							  *
							  * The count still shows: how many people reached a step is a fact at any
							  * size. It is the RATIO that needs a denominator, which is the same rule
							  * the revenue split and the catalogue index already follow.
							  */}
							<Text size={0} muted>
								{/* Gated on BOTH ends. The share was gated on `entry`, which is stage zero and
								    therefore the funnel's largest number — so it was withheld only when the
								    whole funnel had under thirty entries, never when the rung itself was
								    thin. And a withheld step-to-step rate fell silently to an empty string,
								    leaving exactly the unexplained gap the share half avoids. */}
								{index === 0
									? 'entry step'
									: entry >= MIN_RATE_DENOMINATOR && stage.value >= MIN_RATE_DENOMINATOR
										? `${formatPercent(share, 1)} of ${stages[0]?.label.toLowerCase()}`
										: 'too few to give a rate'}
								{index > 1 && stage.conversionFromPrevious !== null && previous
									? (previous.value ?? 0) >= MIN_RATE_DENOMINATOR && stage.value >= MIN_RATE_DENOMINATOR
										? ` · ${formatPercent(stage.conversionFromPrevious, 1)} of ${previous.label.toLowerCase()}`
										: ` · too few from ${previous.label.toLowerCase()} to give a rate`
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
function gapLabel(delta: number, measurement: 'sequence' | 'independent-totals', entry = 0): string {
	if (delta === 0) return measurement === 'sequence' ? 'no drop-off' : 'no difference'
	if (delta > 0) {
		if (measurement !== 'sequence') return `${formatCount(delta)} fewer`
		// The share as well as the count, because the share is what the bar beside it encodes — and
		// a screen-reader user, who gets no bar at all, would otherwise have no way to know how big
		// the loss was relative to everyone who landed.
		const share = entry > 0 ? ` — ${formatPercent(delta / entry, 0)} of everyone who landed` : ''
		return `−${formatCount(delta)} did not continue${share}`
	}
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
	alignItems: 'center',
	justifyContent: 'flex-end',
	gap: 8,
	padding: '4px 2px',
}

/**
 * The rail the abandonment bar sits in.
 *
 * Narrow, and right-aligned with the label, so it reads as a note between two rungs rather than as
 * a sixth stage. It is the same scale as the stage bars above and below it — a share of entry — so
 * the eye can compare a drop-off against the step it came from without converting anything.
 */
const lostTrack: React.CSSProperties = {
	width: '38%',
	maxWidth: 200,
	height: 6,
	borderRadius: 2,
	overflow: 'hidden',
	background: 'currentColor',
	opacity: 0.1,
	// Right to left: the bar grows back toward the funnel it came out of, which reads as leaving
	// rather than as another quantity accumulating alongside.
	display: 'flex',
	justifyContent: 'flex-end',
}

/**
 * The people who did not continue.
 *
 * The one warm mark in the funnel. It is not an error — a drop-off is normal and a foundry's is
 * enormous — so it is drawn at a weight that says "this is the quantity" rather than "this is
 * wrong", and it takes the same colour the timeline gives GA4's shortfall so that "what you lost"
 * looks the same everywhere in the tool.
 */
const lostFill: React.CSSProperties = {
	height: '100%',
	borderRadius: 2,
	background: SERIES.ga4Pageviews,
	opacity: 0.75,
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


/**
 * The fill for a bar's measured portion.
 *
 * An explicit background, NOT `<Card tone="primary">`. Sanity's card tones are page backgrounds
 * meant to sit behind text, never accents: measured against the surrounding track they come out at
 * 1.03:1 in light and 1.12:1 in dark, where WCAG's floor for a meaningful graphical object is 3:1.
 * Three of the four bar idioms were rendering as empty rails with numbers beside them, and
 * `tone="default"` was worse still — a bar lighter than its own track.
 *
 * It also survives the compat shim, whose DOM fallback drops `tone`, `padding`, `radius` and
 * `border` entirely but passes `style` through. A bar whose existence depends on a resolved
 * design token is a bar that vanishes on the Studio versions the shim exists for.
 */
const barFill: React.CSSProperties = {
	height: '100%',
	borderRadius: 2,
	// Through the registry, not a hex plus an opacity chosen here. Drawn at 0.85 this sat at 2.77:1
	// on the light theme while palette.test.ts asserted 3.42:1 against the bare constant — the test
	// measured a colour that was never drawn. MARKS is what both now read.
	background: mark('bar.fill'),
}

/** The track a bar sits in. Visible on its own, so an empty bar still reads as a bar. */
const barTrack: React.CSSProperties = {
	height: 8,
	borderRadius: 2,
	overflow: 'hidden',
	// Furniture, not data: a rail is not a value, so 3:1 does not apply to it — but it is declared
	// in MARKS so that exemption is stated somewhere a reader can check rather than assumed.
	background: mark('bar.track'),
}


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
	/**
	 * Keep this column even when every value in it is blank or zero.
	 *
	 * For the column that identifies the row — a table whose first column collapsed would be a list
	 * of numbers belonging to nothing — and for any column whose emptiness is itself the finding.
	 */
	alwaysShow?: boolean
	render: (row: Row) => React.ReactNode
}

/**
 * Whether a column holds nothing worth a column.
 *
 * Empty means MEASURED and nothing: every visible row returns zero, or an empty string. A table of
 * a foundry's ten families with a Purchases column reading 0 ten times is the case this exists for
 * — the column is as wide as its heading and says only "not this one".
 *
 * NULL DOES NOT COUNT, and that is the whole distinction this package is built on. A column where
 * every value is unavailable is not an empty column, it is the finding that something could not be
 * measured — GA4 attributing no revenue to any source is the loudest thing the acquisition table
 * can tell you, and folding it away would turn the tool's best output into an absence the reader
 * never sees. A column of dashes is meant to be uncomfortable.
 *
 * This is still the one place in the package where a measured zero is treated as nothing, and it
 * is safe only because the table SAYS how many columns it folded and gives them back in one click.
 *
 * @param column - the column under test
 * @param rows - the rows actually on screen, after filtering and exclusion
 */
export function columnIsEmpty<Row>(column: SortColumn<Row>, rows: Row[]): boolean {
	if (column.alwaysShow) return false
	// A table with no rows has no empty columns — it has no columns' worth of evidence either way,
	// and folding every column of an empty table leaves a heading strip and nothing under it.
	if (rows.length === 0) return false
	return rows.every((row) => {
		const value = column.sortValue(row)
		return value === 0 || value === ''
	})
}

/**
 * One titled region of a panel.
 *
 * Every section in this tool was a bare `Stack` with a `Heading size={1}` on top, which meant the
 * panel had exactly one level of hierarchy: the tab title, and then eleven things of equal weight.
 * A reader scanning for "what should I look at" got no help, because nothing on the page claimed to
 * matter more than anything else — and the two blocks that genuinely are reference material,
 * Configuration and Context, shouted as loudly as the traffic table.
 *
 * `tone` sets the weight; `collapsible` is what actually removes noise. A collapsed section renders
 * NO children at all rather than hiding them with CSS, so it costs nothing to draw and cannot be
 * found by a text search of the page — which is the honest behaviour when the reader has said they
 * do not want it.
 */
export function Section({
	title,
	subtitle,
	tone = 'primary',
	collapsible = false,
	defaultOpen = true,
	children,
}: {
	title: string
	/** One line under the heading. Longer explanation belongs inside, not here. */
	subtitle?: React.ReactNode
	/** `secondary` is for reference material a reader consults rather than reads. */
	tone?: 'primary' | 'secondary'
	/** Whether the reader can fold it away. */
	collapsible?: boolean
	/** Start folded, for material that is worth having and not worth reading every time. */
	defaultOpen?: boolean
	children: React.ReactNode
}): React.ReactElement {
	const [open, setOpen] = React.useState(defaultOpen)
	const bodyId = React.useId()
	const shown = !collapsible || open

	return (
		<section>
			<Stack space={3}>
			<div style={sectionHeader}>
				<Stack space={1}>
					<Heading size={tone === 'primary' ? 1 : 0} style={tone === 'primary' ? primaryTitle : secondaryTitle}>
						{title}
					</Heading>
					{subtitle && <Text size={1} muted>{subtitle}</Text>}
				</Stack>
				{collapsible && (
					<button
						type="button"
						style={sectionToggle}
						aria-expanded={open}
						aria-controls={bodyId}
						onClick={() => setOpen((was) => !was)}
					>
						{open ? 'Hide' : 'Show'}
					</button>
				)}
			</div>
			{shown && <div id={bodyId}>{children}</div>}
			</Stack>
		</section>
	)
}

/**
 * A section heading, without the fold.
 *
 * Most sections are not collapsible — they are the content — but they still need the hierarchy the
 * panel had none of: one weight for what you read, a quieter one for what you consult, and a rule
 * so the eye can find where one region ends and the next begins. `Section` uses the same two
 * treatments; this is for the blocks whose markup already owns its own stacking.
 */
export function SectionTitle({
	title,
	tone = 'primary',
}: {
	title: string
	/** `secondary` is for reference material a reader consults rather than reads. */
	tone?: 'primary' | 'secondary'
}): React.ReactElement {
	return (
		<div style={sectionHeader}>
			<Heading size={tone === 'primary' ? 1 : 0} style={tone === 'primary' ? primaryTitle : secondaryTitle}>
				{title}
			</Heading>
		</div>
	)
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
	/** Allow per-row exclusion even without a filter box. */
	onExclude?: boolean
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
	onExclude,
}: SortableTableProps<Row>): React.ReactElement {
	const [sort, setSort] = React.useState<{ key: string; desc: boolean } | null>(
		initialSort ? { key: initialSort, desc: true } : null,
	)
	const [query, setQuery] = React.useState('')
	const [excluded, setExcluded] = React.useState<ReadonlySet<string>>(() => new Set())
	const [copied, setCopied] = React.useState<'idle' | 'done' | 'failed'>('idle')
	// Off by default: the empty columns are the noise this hides. The control below says how many,
	// so the reduction is announced rather than silent.
	const [showEmpty, setShowEmpty] = React.useState(false)
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

	/**
	 * The columns actually drawn.
	 *
	 * Computed from `visible`, not from every row: narrowing the range or filtering the table can
	 * empty a column, and a column that is empty for what is on screen is noise for what is on
	 * screen. The first column is always kept — it names the row — as is whatever is being sorted
	 * on, because folding the sorted column would leave the order unexplained.
	 */
	const emptyColumns = React.useMemo(
		() => columns.filter((column, index) =>
			index > 0 && column.key !== sort?.key && columnIsEmpty(column, visible),
		),
		[columns, visible, sort?.key],
	)
	const shown = showEmpty || emptyColumns.length === 0
		? columns
		: columns.filter((column) => !emptyColumns.includes(column))

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
		// What is on screen, columns included. A CSV carrying columns the table folded would not be
		// the thing the button says it copies, and every one of them would be a column of zeros.
		const header = shown.map((column) => column.label)
		const lines = [header, ...ordered.map((row) => shown.map((column) => {
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

	// Rows the FILTER hid, and only those. `rows.length - visible.length` counted the excluded ones
	// too, because `visible` filters on both — so excluding three rows with no filter text rendered
	// "3 rows hidden · 3 excluded", and the one line whose job is saying what you are looking at was
	// arithmetically wrong.
	const excludedInWindow = rows.filter((row) => excluded.has(rowKey(row))).length
	const hiddenCount = rows.length - visible.length - excludedInWindow
	// Counted independently of whether the excluded rows exist in THIS window. Exclusions now
	// survive a refetch, so excluding a bot referrer on Quarter and then narrowing to a week where
	// it has no sessions left the exclusion armed and the control gone — silently hiding rows on
	// the way back out.
	const excludedCount = excluded.size

	return (
		<Stack space={2}>
			{(filterOn || exportName || emptyColumns.length > 0) && (
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
					{(hiddenCount > 0 || excludedCount > 0) && (
						<Text size={0} muted>
							{hiddenCount > 0 && <>{hiddenCount} row{hiddenCount === 1 ? '' : 's'} hidden</>}
							{excludedCount > 0 && (
								<>
									{hiddenCount > 0 ? ' · ' : ''}
									{excludedCount} excluded{' '}
									<button type="button" style={inlineLink} onClick={() => setExcluded(new Set())}>
										restore
									</button>
								</>
							)}
						</Text>
					)}
					<span style={{ flex: 1 }} />
					{/* Named with a count, not a bare "show all". A reader has to be able to tell the
					    difference between a table with four columns and a table showing four of
					    seven — otherwise this is the tool deciding what the data says. */}
					{emptyColumns.length > 0 && (
						<button
							type="button"
							style={tableControlButton}
							aria-pressed={showEmpty}
							onClick={() => setShowEmpty((open) => !open)}
						>
							{showEmpty
								? `Hide ${emptyColumns.length} empty column${emptyColumns.length === 1 ? '' : 's'}`
								: `Show ${emptyColumns.length} empty column${emptyColumns.length === 1 ? '' : 's'}`}
						</button>
					)}
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
						{shown.map((column) => {
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
								{shown.map((column, index) => {
									const content = column.render(row)
									return index === 0 ? (
										<th key={column.key} scope="row" style={bodyCell}>
											<span style={firstCell}>
												{content}
												{/* Offered where the row set is the reader's to shape. A chart's
												    data table passes neither, because excluding a date there
												    would visibly do nothing to the chart above it — an
												    affordance that does nothing is worse than none. */}
												{filterOn || onExclude ? (
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
												) : null}
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
								{/* Which emptiness this is. It always blamed the filter, so a site with no
								    orders, or an unconfigured GA4, was told it had filtered its own data
								    away — the reader hunting for a control they never touched. */}
								<Text size={1} muted>
									{rows.length === 0
										? 'Nothing to show for this period.'
										: query.trim() || excludedInWindow > 0
											? 'No rows match this filter.'
											: 'Nothing to show for this period.'}
								</Text>
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

/** Title and its control on one line, the control pushed to the trailing edge. */
const sectionHeader: React.CSSProperties = {
	display: 'flex',
	alignItems: 'flex-start',
	justifyContent: 'space-between',
	gap: 12,
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.22))',
	paddingBottom: 6,
}

/** A section the reader is meant to read. */
const primaryTitle: React.CSSProperties = { margin: 0, lineHeight: 1.3 }

/**
 * A section the reader consults.
 *
 * Smaller and quieter, and the difference has to be visible at a glance or the hierarchy this
 * component exists to create is just two words in a prop.
 */
const secondaryTitle: React.CSSProperties = {
	margin: 0,
	lineHeight: 1.3,
	textTransform: 'uppercase',
	letterSpacing: '0.07em',
	opacity: 0.75,
}

/** The fold control. Reads as a control, not as a heading. */
const sectionToggle: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.3))',
	borderRadius: 3,
	color: 'inherit',
	font: 'inherit',
	fontSize: '0.8em',
	padding: '2px 9px',
	cursor: 'pointer',
	flex: '0 0 auto',
}

/**
 * Two blocks side by side on a wide pane, stacked on a narrow one.
 *
 * The minimum is deliberately large: a table squeezed into half of a narrow Studio pane is worse
 * than the same table full width, so the pair splits only when there is genuinely room for both.
 * Like `cardGrid`, it responds to the PANE rather than the viewport, because the panel is a
 * resizable region inside a Studio that is sometimes inside an iframe.
 */
export const splitGrid: React.CSSProperties = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(26rem, 100%), 1fr))',
	gap: 24,
	alignItems: 'start',
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
