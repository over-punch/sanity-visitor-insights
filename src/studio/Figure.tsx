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
import { COMPARISON_TEXT, SERIES, mark } from './palette'
import type { MetricValue, UnavailableReason } from '../types'
import { valueOrNull } from '../types'

/**
 * The four levels of vertical break, in pixels.
 *
 * Sanity's own scale is [0, 4, 8, 12, 20, 32, …] and this tool used one value from it — `space={3}`,
 * twelve pixels — for sixty-four per cent of all vertical spacing, with `space={4}` at twenty for
 * everything structural. So the largest break in the tool was 1.67 times an ordinary gap between
 * two lines inside a card, and a section boundary looked the same as the next line of a caption.
 * That is what "under-designed" meant here: not too little air, too EVEN air.
 *
 * Every step is at LEAST double the one below — 4, 8, 20, 40, so ×2, ×2.5, ×2. That is the property
 * that matters: a level has to be readable at a glance rather than measurable with a ruler, and
 * anything under about ×2 reads as the same level. Twenty rather than sixteen because a card gutter
 * wants the extra room and it is a real token; forty has no token at all — Sanity's scale jumps 32
 * to 52 — which is one more reason these are plain pixels.
 *
 * Plain pixels in `style` rather than `space` props for a second reason: the compat shim's DOM
 * fallback passes `style` through and drops `space`, `padding`, `tone`, `radius` and `border`
 * entirely. On the versions this package supports every primitive resolves, so that is a latent
 * fragility rather than a live fault — but four constants in this file already sidestep it for
 * exactly this reason, and the skeleton was the one part that never did.
 */
export const SPACE = { pair: 4, block: 8, group: 20, section: 40 } as const

/**
 * A stack at each level.
 *
 * `display: grid` rather than a column flexbox: identical on one axis, but grid children do not
 * shrink, so a wide table cannot squash the block beside it. The convention is already in this file
 * — `funnelItem` and NoticeList's list both do it.
 */
export const stackPair: React.CSSProperties = { display: 'grid', gap: SPACE.pair }

/** Label to figure to note, inside one card. */
export const stackBlock: React.CSSProperties = { display: 'grid', gap: SPACE.block }

/** Card to card, check to check, a heading to its own body. */
export const stackGroup: React.CSSProperties = { display: 'grid', gap: SPACE.group }

/** One titled region to the next. The only level above twenty. */
export const panelStack: React.CSSProperties = { display: 'grid', gap: SPACE.section }


/** Human-readable explanation for each unavailable reason. */
const REASON_TEXT: Record<UnavailableReason, string> = {
	not_instrumented: 'Not tracked on this site',
	before_cutover: 'Not tracked during this period',
	// "Withheld ... for privacy" reads as a legal hold on the reader's own data. What actually
	// happened is that too few people did the thing for Google to report it.
	suppressed: 'Google hid it: too few people',
	outage: 'Not recorded during part of this period',
	source_error: 'Source did not respond',
	// "Does not apply" reads as a choice someone made. It is not — there is simply nothing here to
	// compute it from.
	not_applicable: 'Nothing here to work this out from',
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
		// Every other branch ends in "from X". This one used to stop at two words, so the single
		// case where a reader most wants to verify the claim was the one case with no number — and
		// with no arrow either, it read as an ABSENT comparison rather than a measured flat one.
		return (
			<span style={deltaStyle()}>
				no change<span style={baselineStyle}> from {unit === 'percent' ? `${before.toFixed(1)}%` : formatCount(before)}</span>
			</span>
		)
	}

	// A change from zero has no defined percentage in either direction. "+∞%" is what a naive
	// division produces, and asserting `change` non-null let a fall to zero print "↓ 0%".
	const change = before === 0 ? null : absolute / Math.abs(before)
	const rising = absolute > 0
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
		<span style={deltaStyle()}>
			<span aria-hidden="true">{arrow}</span>
			{magnitude ? ` ${magnitude}` : ''}
			<span style={baselineStyle}> from {baseline}</span>
			{/* Said, rather than left as a gap after the arrow. `magnitude` is empty exactly when the
			    baseline is too small to carry a percentage, and "↑  from 4" read as a bug. */}
			{tooFewToRate && <span style={baselineStyle}> · too few to rate</span>}
		</span>
	)
}

/**
 * Delta styling. Direction is carried by the arrow and the words as well as the colour, so the
 * meaning survives a monochrome or colour-blind reading.
 */
function deltaStyle(): React.CSSProperties {
	// ONE colour for everything that refers to the other window — see COMPARISON in palette.ts.
	//
	// This used to vary by tone: opacity 0.9 or 0.55, plus a rule under a bad move and none under a
	// good one. Three cards side by side therefore showed three different treatments, and a reader
	// reported it as an inconsistency rather than reading it as meaning. It was meaning — but
	// meaning already carried twice over, by the arrow and by the sign on the magnitude, so the
	// third channel bought nothing and cost the identity.
	//
	// The underline had a second problem once the text was coloured: a coloured, underlined inline
	// span is the browser's hyperlink signature, and these sit on the same screens as real links.
	//
	// Full alpha is not a preference. COMPARISON clears 3:1 only at alpha 1; the opacity ladder
	// this replaces put it at 2.1.
	return {
		fontFamily: 'inherit',
		fontSize: '0.8em',
		fontWeight: 500,
		color: COMPARISON_TEXT,
		whiteSpace: 'nowrap',
	}
}

/**
 * The baseline inside a delta.
 *
 * Same colour, one step down in weight. Weight alone separates "the move" from "what it moved from"
 * without breaking the identity or dropping below the contrast floor.
 */
const baselineStyle: React.CSSProperties = { color: COMPARISON_TEXT, fontWeight: 400 }

/** Gap between the crosshair and the card, on whichever side it lands. */
const HOVER_GUTTER = 14

/** The card's widest possible layout — `hoverCard.maxWidth`, which the flip has to respect. */
const HOVER_CARD_MAX = 260

export function HoverCard({
	x,
	paneWidth,
	date,
	rows,
	events,
}: {
	/** Plot-space x of the crosshair, in CSS pixels. */
	x: number
	/** The measured pane width, for the flip decision. */
	paneWidth: number
	/** The day, already formatted. */
	date: string
	/** One entry per series, in the stack's own order. */
	rows: Array<{ key: string; label: string; color: string; value: string; seen: string | null }>
	/** Campaign sends or other markers on this day. */
	events: string[]
}): React.ReactElement {
	// Flip rather than clamp. A clamped card stops tracking the crosshair and then sits ON the
	// thing it describes for the whole right-hand edge.
	//
	// The threshold is the card's own width, not a fraction of the pane. A fixed 0.66 was right on
	// a wide pane and wrong on a narrow one: at 400px a crosshair at 60% left 146px of room for a
	// card that wants up to 260, and `frameStyle`'s overflow:hidden took the rest off.
	const flip = x + HOVER_GUTTER + HOVER_CARD_MAX > paneWidth
	return (
		<div
			style={{
				...hoverCard,
				left: flip ? undefined : x + HOVER_GUTTER,
				right: flip ? paneWidth - x + HOVER_GUTTER : undefined,
			}}
		>
			<div style={hoverDate}>{date}</div>
			{rows.map((row) => (
				<div key={row.key} style={hoverRow}>
					{/* The same block that labels the row in the plot, so the two are one legend. */}
					<span style={{ ...hoverSwatch, background: row.color }} />
					<span style={hoverLabel}>{row.label}</span>
					<span style={hoverValue}>
						{row.value}
						{row.seen && <span style={hoverSeen}> · {row.seen}</span>}
					</span>
				</div>
			))}
			{events.map((event) => (
				<div key={event} style={hoverEvent}>{event}</div>
			))}
		</div>
	)
}

/**
 * The floating card.
 *
 * Its ground is the Studio's own card colour so it reads as a surface rather than a tooltip drawn
 * by the chart, and it carries a border because at low contrast a shadow alone disappears on the
 * dark theme.
 */
const hoverCard: React.CSSProperties = {
	position: 'absolute',
	top: 8,
	// Never the element under the pointer: the card follows the crosshair, and taking a pointer
	// event would end the hover that positions it.
	pointerEvents: 'none',
	zIndex: 2,
	minWidth: 168,
	maxWidth: HOVER_CARD_MAX,
	padding: '8px 10px',
	borderRadius: 4,
	background: 'var(--card-bg-color, #ffffff)',
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.35))',
	boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
	display: 'flex',
	flexDirection: 'column',
	gap: 4,
}

/** The day, which is the card's heading. */
const hoverDate: React.CSSProperties = { fontSize: 11, fontWeight: 600, opacity: 0.9, marginBottom: 2 }

/** One series line: swatch, name, value. */
const hoverRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, lineHeight: 1.4 }

/** The colour block, matching the one beside the row's name in the plot. */
const hoverSwatch: React.CSSProperties = { width: 8, height: 8, borderRadius: 2, flex: '0 0 auto' }

/** The series name, which yields its space to the figure. */
const hoverLabel: React.CSSProperties = { opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

/** The figure, pushed right and tabular so a column of them lines up. */
const hoverValue: React.CSSProperties = { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontWeight: 500, whiteSpace: 'nowrap' }

/** What the lossier source saw of the same thing, quieter than the answer it qualifies. */
const hoverSeen: React.CSSProperties = { opacity: 0.6, fontWeight: 400 }

/** A campaign send or other dated marker on the hovered day. */
const hoverEvent: React.CSSProperties = { fontSize: 11, opacity: 0.8, borderTop: '1px solid var(--card-border-color, rgba(128,128,128,0.25))', paddingTop: 4, marginTop: 2 }


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
	 *
	 * 'money' writes the figure in the range's currency. Without it a PARTIAL revenue reached the
	 * count formatter, so Darden's default tab — where revenue is permanently partial, because most
	 * orders predate the amount field — rendered its headline money as a bare "12,346", beside an
	 * "Average order US$455" that did carry a currency.
	 */
	unit?: 'count' | 'percent' | 'money'
	/** ISO 4217 code. Read only when `unit` is 'money'. */
	currency?: string | null
}

/**
 * The badge on a partial figure.
 *
 * It was the fixed string "Some orders only", written for the revenue case and then applied to
 * every partial metric in the tool — including the GA4 view counts on Typeface interest, where it
 * is simply false: those are pageviews spanning an event cutover, and no order is involved.
 *
 * `coveredFrom` distinguishes the two. A cutover or an outage carries the date coverage begins; a
 * gap in the order book does not.
 *
 * @param metric - the partial value
 */
function partialBadge(metric: { coveredFrom?: string }): string {
	return metric.coveredFrom ? `From ${formatDay(metric.coveredFrom)} only` : 'Some orders only'
}

/**
 * Render a metric value, handling the absent case visibly.
 * Screen readers get the reason text rather than an unexplained dash.
 */
export function MetricFigure({ metric, label, size = 4, unit = 'count', currency = null }: MetricFigureProps): React.ReactElement {
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
	const formatted = unit === 'percent'
		? `${metric.value.toFixed(1)}%`
		: unit === 'money'
			? formatMoney(metric.value, currency)
			: formatCount(metric.value)

	if (metric.status === 'partial') {
		return (
			<Stack space={2}>
				<Text size={size}>
					{formatted}
					<span style={visuallyHidden}>, partial. {metric.note}</span>
				</Text>
				<Badge tone="caution" fontSize={0}>{partialBadge(metric)}</Badge>
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
			: unit === 'money'
				? `${formatMoney(metric.low, currency)} to ${formatMoney(metric.high, currency)}`
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
	/**
	 * Set when this step was only instrumented part-way through the window.
	 *
	 * The count is real but it covers fewer days than the rungs around it, so any ratio drawn
	 * across the two is arithmetic over mismatched windows. `JourneyPanel` used to drop the
	 * metric's `partial` status on the way in, so a `view_item` that began firing on 1 September
	 * was drawn identically to a full-month `page_view` and captioned "33.9% of landed" — a
	 * thirteen-day numerator over a thirty-one-day denominator, stated to a decimal place.
	 *
	 * Everywhere else a partial metric carries a badge and a note; this was the one render site
	 * that stripped it, and it is the most quoted number on the tab.
	 */
	partial?: { from: string }
	/**
	 * This rung split by audience segment, in a stable order across rungs.
	 *
	 * The bar's WIDTH is unchanged — still this rung's share of the entry step — and the split
	 * subdivides that width. So a segment collapsing reads as its portion shrinking down the column,
	 * against a total that stays honestly anchored to entry.
	 *
	 * This replaces a second chart. `SurvivalLines` drew the same segments as normalised shares on
	 * its own axis, above a funnel drawing the pooled counts: two pictures of one fact, and the
	 * share-only one could not print a count, which at rungs of 23 and 12 and 7 is the only fact
	 * that survives. Its denominator floor also silenced it at exactly those rungs.
	 */
	segments?: ReadonlyArray<{ key: string; label: string; value: number }>
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
export const MIN_RATE_DENOMINATOR = 30

/**
 * An ISO date as a reader would say it: `1 Sep`.
 *
 * The cutover note states the raw `2026-09-01`, which is right in a machine-written caveat and
 * wrong in a sentence under a chart.
 *
 * @param iso - a `YYYY-MM-DD` date
 */
export function formatDay(iso: string): string {
	const date = new Date(`${iso}T00:00:00Z`)
	if (Number.isNaN(date.getTime())) return iso
	return `${date.getUTCDate()} ${date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

/**
 * The colour for one audience segment.
 *
 * Colour, not pattern. The chart this came from separated its lines by dash alone, which ran out at
 * three segments and was distorted by the stretched viewBox it was drawn in. The keys are borrowed
 * from the series palette because they already clear 3:1 on both grounds; they carry no source
 * meaning here, and the key beneath the funnel states which is which.
 *
 * @param index - the segment's position in the stack
 */
function segmentColour(index: number): string {
	const names = ['survival.line', 'survival.line.2', 'survival.line.3', 'survival.line.4']
	return mark(names[index % names.length] as string)
}

/**
 * The segments present anywhere in the funnel, in first-seen order.
 *
 * Read off the stages rather than passed in, so the key cannot name a segment no rung draws — the
 * failure this package keeps finding in its own legends.
 *
 * @param stages - the rungs
 */
function segmentKeys(stages: readonly FunnelStage[]): Array<{ key: string; label: string }> {
	const seen = new Map<string, string>()
	for (const stage of stages) {
		for (const segment of stage.segments ?? []) {
			if (segment.value > 0 && !seen.has(segment.key)) seen.set(segment.key, segment.label)
		}
	}
	return [...seen].map(([key, label]) => ({ key, label }))
}

/**
 * One segment's share of the rung it sits in.
 *
 * Clamped at the bottom only. A segment larger than the rung it belongs to is a real disagreement
 * between two GA4 queries rather than a rendering problem, and letting the row overflow its track
 * would hide it — so the shares are normalised by their own sum when they exceed the whole, which
 * keeps the bar's length truthful and lets the imbalance show as a changed proportion.
 *
 * @param value - the segment's count
 * @param whole - the rung's count
 */
function segmentShare(value: number, whole: number): number {
	if (!(whole > 0) || !(value > 0)) return 0
	return Math.min(1, value / whole)
}

/**
 * The line under one funnel rung.
 *
 * ONE clause, where there used to be two. The step-to-step rate was a second sentence on the same
 * line, each half with its own withhold-fallback — so on a six-rung funnel at a foundry's volumes
 * the panel printed "too few to give a rate" six times, twice per rung on three consecutive rungs.
 * It was the most repeated string in the tool, and the two clauses were the same picture twice:
 * the bars are anchored to entry, so share-of-entry is already drawn.
 *
 * Silence is the honest default when a rate is withheld — the count is still in the bar header, and
 * `shortListNote` elsewhere in this package already follows that rule. The one thing worth saying
 * out loud is a partial window, because that is a fact about the number rather than an absence of
 * one.
 *
 * @param stage - the rung
 * @param index - its position, so the entry rung can name the scale
 * @param entry - the first rung's count, which is the denominator and the rail's full width
 * @param share - stage over entry, unclamped
 * @param entryLabel - the first rung's name, for the sentence
 */
function rateLine(
	stage: FunnelStage,
	index: number,
	entry: number,
	share: number,
	entryLabel: string,
): React.ReactElement | null {
	// Turns the rail into a scale. "entry step" restated that the first bar was the first bar; this
	// says what a full-width bar means, which is the one thing the chart never stated.
	if (index === 0) return <Text size={0} muted>100% — everyone who arrived</Text>

	// A count measured over fewer days than its denominator cannot carry a rate against it.
	//
	// The wording matters as much as the withholding. "Only counted from 1 Sep" reads as a fault —
	// something broke, GA4 lost data — when the truth is the opposite: nobody was looking before
	// that date because the tracking did not exist. The server already builds that sentence and it
	// was being dropped on the way in.
	if (stage.partial) {
		return (
			<Text size={0} muted>
				tracking added {stage.partial.from}, so this step covers fewer days than the ones above — no
				share is shown
			</Text>
		)
	}

	const canRate = entry >= MIN_RATE_DENOMINATOR && stage.value >= MIN_RATE_DENOMINATOR
	if (!canRate) return null

	return <Text size={0} muted>{formatPercent(share, 1)} of {entryLabel.toLowerCase()}</Text>
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

	// Whether ANY rung had to withhold a rate. One sentence under the chart is the honest scope for
	// this: the rule is a property of the funnel, not of each rung, and stating it per rung made it
	// the most repeated string in the tool.
	const withheldAny = stages.some((stage, index) =>
		index > 0 && !stage.partial && !(entry >= MIN_RATE_DENOMINATOR && stage.value >= MIN_RATE_DENOMINATOR),
	)

	return (
		<>
		<ol style={funnelList}>
			{stages.map((stage, index) => {
				const previous = index > 0 ? stages[index - 1] : null
				// The share is printed unclamped and the WIDTH is clamped separately. Clamping the
				// share itself printed a fallback stage of 500 against an entry of 100 as "100.0%
				// of landed" — the one reading that hides the anomaly the caveat exists to explain.
				const share = entry > 0 ? stage.value / entry : 0
				const width = Math.max(1.5, Math.min(1, share) * 100)
				const active = activeKey === stage.key
				// Whether this rung is split, and how much of it the named segments leave over.
				const hasSplit = (stage.segments?.length ?? 0) > 0
				const remainder = hasSplit
					? Math.max(0, 1 - (stage.segments ?? []).reduce((sum, s) => sum + segmentShare(s.value, stage.value), 0))
					: 0
				const delta = previous ? previous.value - stage.value : 0

				return (
					<li key={stage.key} style={funnelItem}>
						{previous && gapLabel(delta, measurement, entry) !== '' && (
							<div style={funnelGapStyle(measurement === 'sequence' && delta > 0 && entry > 0)}>
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

							{/* A partial rung gets NO BAR AT ALL — not a short one, and not a long one.
							
							    Drawing it at its raw share was the first mistake: the sentence said "no share
							    is shown" while the geometry went on showing one, about half the length it
							    should be. Drawing it as a full-width hatched rail was the second, and it was
							    worse: in a column where LENGTH IS THE VALUE, that handed the least-measured
							    rung the longest mark on the chart — a refusal drawn with more authority than
							    any measurement on the page.
							
							    An empty slot in a column of bars cannot be mis-measured in either direction,
							    and the count in the header above keeps it from reading as a zero. */}
							{stage.partial
								? <div style={partialSlot} />
								: (
									<div aria-hidden="true" style={{ ...barTrack, height: 10 }}>
										<div
											style={{
												...barFill,
												width: `${width}%`,
												display: 'flex',
												overflow: 'hidden',
												// Transparent when split. Left as the ordinary fill, the parent's own
												// colour showed through wherever the segments did not reach — and on a
												// rung where they sum to 451 of 475 that painted the missing 24 in the
												// FIRST segment's colour, reading as a third segment of it.
												...(hasSplit ? { background: 'transparent' } : {}),
											}}
										>
											{/* The split subdivides the bar; it never changes its length. The rung's
											    width stays its share of entry, so the funnel's scale is untouched and
											    the segments read as portions of a total that is still anchored. */}
											{(stage.segments ?? []).map((segment, segmentIndex) => (
												<div
													key={segment.key}
													style={{
														width: `${segmentShare(segment.value, stage.value) * 100}%`,
														background: segmentColour(segmentIndex),
														height: '100%',
													}}
												/>
											))}
											{/* Whatever the named segments do not account for — a device category GA4
											    reported under neither, or a rounding gap between two queries. Drawn in
											    the neutral so it cannot be mistaken for a segment, and keyed as such. */}
											{hasSplit && remainder > 0 && (
												<div style={{ width: `${remainder * 100}%`, background: mark('bar.track'), height: '100%' }} />
											)}
										</div>
									</div>
								)}

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
							{rateLine(stage, index, entry, share, stages[0]?.label ?? '')}
						</div>
					</li>
				)
			})}
		</ol>
		{/* The hatch gets a key. It is a new mark, drawn on the loudest rungs in the chart, and it
		    shipped with nothing anywhere saying what it meant — in the same work whose whole subject
		    was legends that do not match their graphs. */}
		{segmentKeys(stages).length > 0 && (
			<div style={funnelSegmentKey}>
				{segmentKeys(stages).map((segment, index) => (
					<Text key={segment.key} size={0} muted>
						<span aria-hidden="true" style={{ ...hoverSwatch, background: segmentColour(index), display: 'inline-block', marginRight: 6 }} />
						{segment.label}
					</Text>
				))}
			</div>
		)}
		{stages.some((stage) => stage.partial) && (
			<Text size={0} muted>
				{/* Explains the ABSENCE, now that there is no mark to key. A legend for a stripe that is
				    no longer drawn would be the fault this work started from, in reverse. */}
				Steps with no bar were only tracked for part of this period, so they cover fewer days than
				the ones above and cannot be drawn against them. Their counts are exact for the days they
				do cover.
			</Text>
		)}
		{withheldAny && (
			<Text size={0} muted>
				Shares are shown only for steps at least {MIN_RATE_DENOMINATOR} people reached. Below that a
				percentage moves too far on one more visitor to mean anything; the counts above are exact.
			</Text>
		)}
		</>
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
	// On the fallback, only the ANOMALY is worth a line.
	//
	// The drop-off BAR is drawn for a tracked sequence only, so on independent totals every gap
	// label rendered right-aligned against empty space. "N fewer" was also arithmetic the reader can
	// do from the two counts either side of it, on every gap, under a caution card that specifically
	// forbids reading these gaps as drop-off — so it was noise that contradicted the warning above
	// it. A rung LARGER than the one above cannot be inferred that way and is the fallback's
	// characteristic surprise, so that one stays.
	if (measurement !== 'sequence' && delta >= 0) return ''
	if (delta === 0) return 'no drop-off'
	if (delta > 0) {
		// The share as well as the count, because the share is what the bar beside it encodes — and
		// a screen-reader user, who gets no bar at all, would otherwise have no way to know how big
		// the loss was relative to everyone who landed.
		const share = entry > 0 ? ` — ${formatPercent(delta / entry, 0)} of everyone who landed` : ''
		return `−${formatCount(delta)} did not continue${share}`
	}
	// A rung larger than the one above it. Under independent totals that is the fallback's
	// characteristic surprise — add_to_cart can exceed page_view — and the guard above routes it
	// here deliberately. Under a tracked sequence it should be impossible, which makes it worth
	// stating either way.
	return `${formatCount(-delta)} more — not a subset of the step above`
}

/**
 * The space a bar would have occupied on a rung that has none.
 *
 * Reserved rather than collapsed, so the rungs keep their rhythm down the column and the missing
 * mark reads as deliberate rather than as something that failed to render.
 */
const partialSlot: React.CSSProperties = { height: 10 }

/** The segment key, sat under the funnel with the other things said once per chart. */
const funnelSegmentKey: React.CSSProperties = { display: 'flex', gap: SPACE.group, flexWrap: 'wrap', paddingTop: SPACE.pair }

/** One rung: tier, term, bar, figures. */
const ladderRow: React.CSSProperties = {
	display: 'grid',
	gridTemplateColumns: 'minmax(80px, 1.1fr) minmax(60px, 0.8fr) minmax(60px, 2fr) auto',
	gap: SPACE.block,
	alignItems: 'center',
}

/** The rail a rung's bar sits in. */
const ladderTrack: React.CSSProperties = {
	position: 'relative',
	height: 8,
	borderRadius: 4,
	overflow: 'hidden',
	background: mark('bar.track'),
}

/** Orders and money, right-aligned and tabular so a column of them lines up. */
const ladderValue: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

/** The apportioned share, quieter than the exact count it follows. */
const ladderMoney: React.CSSProperties = { opacity: 0.7 }

/** The funnel's list wrapper. Numbering is suppressed — the rungs are already in order visually. */
const funnelList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }

/** One rung and its preceding gap. */
const funnelItem: React.CSSProperties = { display: 'grid', gap: 4 }

/**
 * The space between two rungs, where the drop-off is named.
 *
 * Right-aligned only when there is a bar to align against. Under independent totals no bar is
 * drawn, so `flex-end` pushed the text to the right of nothing.
 */
function funnelGapStyle(hasBar: boolean): React.CSSProperties {
	return {
		display: 'flex',
		alignItems: 'center',
		justifyContent: hasBar ? 'flex-end' : 'flex-start',
		gap: 8,
		padding: '4px 2px',
	}
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
						<Badge tone="caution" fontSize={0}>Note</Badge>
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
		<section style={sectionBox}>
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
			{/* A Stack, not a bare div. See the note on sectionBox. */}
			{shown && <div id={bodyId} style={sectionBody}>{children}</div>}
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

/**
 * A part drawn INSIDE its whole, rather than beside it.
 *
 * The tool's central fact — GA4 sees a fifth of the traffic Vercel counts — was drawn as two peer
 * bars scaled to the larger of the pair. Vercel is always the larger, so its bar was always full
 * width on every site and every range: it carried no information at all, while a caption underneath
 * had to explain in words that one bar was "a subset of the bar above, not a rival measurement".
 * Two bars side by side encode RIVALS. The encoding asserted the opposite of the truth and the
 * prose was there to take it back.
 *
 * One bar says it without the sentence: the whole is the track, the part is filled inside it, and
 * what is left over is the quantity the reader came for.
 *
 * REFUSES when the part exceeds the whole. That happens for real — GA4 counts more than Vercel
 * wherever Vercel's collection started later than the range, which is routine on MCKL — and
 * containment is then simply the wrong picture. The caller falls back rather than this component
 * drawing a fill wider than its own track.
 */
/**
 * Whether one figure is genuinely contained by another, so a part-inside-whole bar is honest.
 *
 * False where either side is unmeasured, and false where the part exceeds the whole — which is
 * real rather than hypothetical: GA4 counts more than Vercel wherever Vercel's collection started
 * after the range began, as it does on MCKL. Exported so the caller can choose its encoding rather
 * than discovering a null mid-render.
 *
 * @param whole - the complete count
 * @param part - the lossier count that should sit inside it
 */
export function isContainment(whole: MetricValue | undefined, part: MetricValue | undefined): boolean {
	const w = valueOrNull(whole)
	const p = valueOrNull(part)
	return w !== null && p !== null && w > 0 && p <= w
}

export function ContainmentBar({
	wholeLabel,
	whole,
	partLabel,
	part,
	missingLabel,
}: {
	wholeLabel: string
	whole: MetricValue
	partLabel: string
	part: MetricValue
	/** What the unfilled remainder means, e.g. "not seen by GA4". */
	missingLabel: string
}): React.ReactElement | null {
	const wholeValue = valueOrNull(whole)
	const partValue = valueOrNull(part)

	// Either side unmeasured, or the part larger than the whole: not a containment.
	if (!isContainment(whole, part)) return null
	if (wholeValue === null || partValue === null) return null

	const share = partValue / wholeValue
	const missing = wholeValue - partValue

	return (
		<Stack space={2}>
			<div style={barHeader}>
				<Text size={1}>{wholeLabel}</Text>
				<Text size={1} weight="medium">{formatCount(wholeValue)}</Text>
			</div>
			{/* The track IS the whole. Nothing here is scaled to a maximum computed from the pair,
			    so neither bar can be full width by construction. */}
			<div aria-hidden="true" style={{ ...barTrack, background: mark('bar.fill'), height: 14 }}>
				<div style={{ height: '100%', width: `${share * 100}%`, background: mark('bar.seen'), borderRadius: 2 }} />
			</div>
			<div style={barHeader}>
				<Text size={0} muted>
					{partLabel}: {formatCount(partValue)} ({formatPercent(share, 0)})
				</Text>
				<Text size={0} muted>
					{formatCount(missing)} {missingLabel}
				</Text>
			</div>
		</Stack>
	)
}

/**
 * Three independent estimates of one number, on one axis.
 *
 * The capture model computes how much of reality GA4 is seeing three separate ways — against the
 * order book, against email clicks, against Vercel — and `capture.ts` is explicit that they are
 * deliberately NOT averaged, because the DISAGREEMENT between them is the useful output. Rendered
 * as three cards in a grid, that disagreement is a subtraction the reader performs by eye, and the
 * grid reorders itself by pane width so even their sequence is unstable.
 *
 * On one axis it is a distance. Three dots, a rule at 100%, and each dot carrying the interval its
 * own sample size leaves — so the estimate built on seven orders draws a bar most of the axis wide
 * and the reader can see, without being told, which of the three to discount.
 *
 * That interval already existed. `samplingInterval` has been in capture.ts throughout, documented
 * with "printing that is the point", and was drawn nowhere.
 *
 * No d3-shape: an axis, three rows, a rule. The scale opens past 100% because a rate above 1 is a
 * real fault this package reports rather than an impossibility — the same reason the coverage row
 * is no longer clamped.
 */
/** What the plot needs of an estimate. Matches the core model's CaptureEstimate structurally. */
export interface EstimateForPlot {
	basis: string
	rate: number
	observed: number
	actual: number
	note: string
}

export function EstimateDotPlot<E extends EstimateForPlot>({
	estimates,
	labelFor,
	intervalFor,
}: {
	estimates: ReadonlyArray<E>
	/** How to name a basis to the reader. */
	labelFor: (basis: E['basis']) => string
	/**
	 * The sampling interval for an estimate, from the core capture model.
	 *
	 * Takes the whole estimate rather than a narrowed shape: a structural `{ rate, actual }` looks
	 * tidier and cannot be satisfied by `samplingInterval`, whose parameter is the full
	 * CaptureEstimate — so the caller would have to wrap it for no benefit.
	 */
	intervalFor: (estimate: E) => { low: number; high: number }
}): React.ReactElement | null {
	if (estimates.length === 0) return null

	const intervals = estimates.map((e) => intervalFor(e))
	// Opens past 1 when anything exceeds it, so an over-count is visible rather than pinned to the
	// right edge reading as "perfect".
	const top = Math.max(1, ...estimates.map((e) => e.rate), ...intervals.map((i) => i.high))
	const pct = (v: number) => `${(Math.max(0, Math.min(1, v / top))) * 100}%`

	return (
		<Stack space={3}>
			{estimates.map((estimate, index) => {
				const interval = intervals[index] as { low: number; high: number }
				const wide = interval.high - interval.low > 0.4
				return (
					<Stack key={estimate.basis} space={2}>
						<div style={barHeader}>
							<Text size={1}>{labelFor(estimate.basis)}</Text>
							<Text size={1} weight="medium">{formatPercent(estimate.rate, 0)}</Text>
						</div>
						<div aria-hidden="true" style={estimateTrack}>
							{/* The rule first, so a dot at 100% sits on top of it rather than under. */}
							<div style={{ ...estimateRule, left: pct(1) }} />
							<div
								style={{
									...estimateInterval,
									left: pct(interval.low),
									width: `calc(${pct(interval.high)} - ${pct(interval.low)})`,
								}}
							/>
							<div style={{ ...estimateDot, left: pct(estimate.rate) }} />
						</div>
						<Text size={0} muted>
							{formatCount(estimate.observed)} of {formatCount(estimate.actual)}
							{/* Said in words as well as drawn, because the bar is aria-hidden and because
							    "this one is too thin to lean on" is the conclusion, not the picture. */}
							{wide && ' — too small a sample to lean on'}
							{/* EACH ESTIMATE'S OWN BIAS, which was written, required by this component's
							    props type, and rendered nowhere.
							
							    Three dots share an axis so their DISAGREEMENT is legible — but each is
							    wrong in a different direction, and that direction is the only thing telling
							    a reader which dot to move toward. Pageviews is a ceiling; orders moves ~14
							    points on one more GA4 purchase; email measures tagging as much as capture.
							    Without them a reader seeing 45% and 20% has a spread and no way to resolve
							    it — and on a Week range there is often only ONE dot, no discrepancy card,
							    and nothing at all saying what that dot means. */}
							{estimate.note && <span style={estimateNote}>{estimate.note}</span>}
							{/* The CAUSE, not just the fact. "Over 100%" states the reading; "usually a tag
							    firing twice" is the half a reader can act on, and dropping it when this
							    moved from cards to a plot would have been a quiet loss — caught by the
							    test that pinned it. */}
							{estimate.rate > 1.05 && ' — over 100%, so GA4 is counting more than the source it is checked against. That is usually a tag firing twice, not extra traffic.'}
						</Text>
					</Stack>
				)
			})}
			{/* The shared footer is gone: three notes that each say what their own estimate is make a
			    sentence saying "each is a separate way of asking the same question" redundant. The one
			    fact the notes cannot carry is what the rule means, so that is all this says now. */}
			<Text size={0} muted>The rule marks 100%.</Text>
		</Stack>
	)
}

/** One licence line, as the order book records it. */
export interface LicenceLadderRow {
	type: string
	tier: string
	/** The tier's rung on the price ladder. Rows are read in this order, never by size. */
	tierValue: number
	term: string
	orders: number
	/** The order total split evenly across the licences on it — a share, not a price. */
	revenue: number | null
}

/**
 * Licence sales, faceted by type, with each type's tiers in ladder order.
 *
 * Three dimensions, three channels: type is a facet, tier is vertical position within it, term is a
 * sub-row. The previous encoding flattened all three into one `type · tier` string on a single axis
 * and then sorted that axis by value — which is the one thing an ordinal ladder cannot survive, and
 * which put the two term-rows of a single tier as far apart as their values happened to fall. The
 * caption above it asked whether a tier that sells at one year also sells at perpetual; the drawing
 * separated exactly those two rows.
 *
 * Bars are ORDERS and share one scale across every facet, so a rung in Desktop is comparable with a
 * rung in Web. Orders because they are exact and unapportioned: a row's revenue is its order's total
 * divided evenly by the licences on that order, which is a share rather than a price, and ranking a
 * ladder by it ranks the split as much as the sales.
 */
export function LicenceLadder({ rows, currency }: {
	rows: readonly LicenceLadderRow[]
	currency: string | null
}): React.ReactElement | null {
	if (rows.length === 0) return null

	// One scale for the whole chart. Per-facet scaling would make a one-order type look as busy as
	// the type carrying the business.
	const peak = Math.max(1, ...rows.map((row) => row.orders))

	const types: Array<{ type: string; rungs: LicenceLadderRow[] }> = []
	for (const row of rows) {
		const facet = types.find((t) => t.type === row.type)
		if (facet) facet.rungs.push(row)
		else types.push({ type: row.type, rungs: [row] })
	}

	return (
		<Stack space={4}>
			{types.map((facet) => (
				<Stack key={facet.type} space={2}>
					<Text size={1} weight="semibold">{facet.type}</Text>
					{facet.rungs.map((row, index) => {
						// The tier name prints once per rung; a term sharing the tier above it is
						// indented under it, which is what makes the two terms of one tier read as a pair.
						const sameTierAsAbove = index > 0 && facet.rungs[index - 1]?.tier === row.tier
						return (
							<div key={`${row.tier}\u0000${row.term}`} style={ladderRow}>
								<Text size={0} muted>{sameTierAsAbove ? '' : row.tier}</Text>
								<Text size={0} muted>{row.term}</Text>
								<div aria-hidden="true" style={ladderTrack}>
									<div style={{ ...barFill, width: `${Math.max(2, (row.orders / peak) * 100)}%` }} />
								</div>
								<Text size={0} style={ladderValue}>
									{formatCount(row.orders)}
									{row.revenue !== null && (
										<span style={ladderMoney}> · {formatMoney(row.revenue, currency)}</span>
									)}
								</Text>
							</div>
						)
					})}
				</Stack>
			))}
		</Stack>
	)
}

/**
 * A ratio you can turn over to see what it is made of.
 *
 * At a foundry's volumes a derived rate is the least trustworthy thing on the page and often the
 * most quotable: "337 visitors per order" reads like a fact, and one more sale moves it to 295. The
 * package's answer everywhere else is to withhold — a rate below its denominator floor is simply
 * not printed. That is right for a rate the reader did not ask for and wrong for one they did,
 * because withholding leaves them with nothing.
 *
 * So: show it, and make its basis one click away. The counts face is not a footnote — it is the
 * same figure told honestly, and a reader who flips it once learns for themselves how thin the
 * arithmetic is. That is a better lesson than a caveat they skim.
 *
 * The toggle is per-card state and deliberately not persisted. It answers "what is this made of"
 * in the moment; remembering the answer across sessions would leave a reader staring at raw counts
 * with no memory of asking for them.
 */
export function RatioFigure({
	value,
	format,
	parts,
	size = 4,
	unavailable,
}: {
	/** The ratio itself. Null when it could not be computed. */
	value: number | null
	/** How to render the ratio. */
	format: (value: number) => string
	/** What it is made of, in reading order: numerator then denominator. */
	parts: ReadonlyArray<{ label: string; value: number | null; format?: (value: number) => string }>
	size?: 0 | 1 | 2 | 3 | 4
	/** Shown in place of the figure when the ratio is null. */
	unavailable?: React.ReactNode
}): React.ReactElement {
	const [showParts, setShowParts] = React.useState(false)

	// Nothing to turn over: if the ratio could not be computed, the parts are what there is.
	const canToggle = value !== null && parts.every((p) => p.value !== null)

	return (
		<Stack space={2}>
			<div style={ratioRow}>
				{showParts && canToggle
					? (
						<Stack space={1}>
							{parts.map((part) => (
								<Text key={part.label} size={size > 1 ? 2 : size}>
									{(part.format ?? formatCount)(part.value as number)}{' '}
									<Text as="span" size={0} muted>{part.label}</Text>
								</Text>
							))}
						</Stack>
					)
					: value === null
						? unavailable
						: <Text size={size}>{format(value)}</Text>}
				{canToggle && (
					<button
						type="button"
						style={ratioToggle}
						aria-pressed={showParts}
						// Named for what it reveals, not "toggle": a reader should know what they will
						// get before pressing, and the label is the only thing telling them.
						aria-label={showParts ? 'Show the rate' : 'Show the counts behind this rate'}
						onClick={() => setShowParts((was) => !was)}
					>
						{showParts ? 'rate' : 'counts'}
					</button>
				)}
			</div>
		</Stack>
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

		<Card radius={2} tone="transparent" style={tableWrapper}>
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
	gap: SPACE.block,
	flexWrap: 'wrap',
}

/** A section: its heading, then its body, at group spacing. */
const sectionBox: React.CSSProperties = { display: 'grid', gap: SPACE.group }

/**
 * A section's body, which owns the rhythm between its own children.
 *
 * This is the line that had `Section` used four times against `SectionTitle`'s eight.
 */
const sectionBody: React.CSSProperties = { display: 'grid', gap: SPACE.group }

/** Title and its control on one line, the control pushed to the trailing edge. */
const sectionHeader: React.CSSProperties = {
	display: 'flex',
	alignItems: 'flex-start',
	justifyContent: 'space-between',
	gap: 12,
	// 0.35, not 0.22. This rule was the faintest line in the file and the only thing separating one
	// section from the next — while every button drew at 0.30. A "Hide" control outranking the
	// boundary between two regions of the panel is the hierarchy upside down.
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.35))',
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
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.22))',
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

/** The axis a capture estimate is plotted on. Relative, so the marks position against it. */
const estimateTrack: React.CSSProperties = {
	position: 'relative',
	height: 18,
	borderRadius: 2,
	background: mark('bar.track'),
}

/** One estimate's own caveat, on its own line beneath the counts it qualifies. */
const estimateNote: React.CSSProperties = { display: 'block', marginTop: 2, opacity: 0.85 }

/** The 100% reference. A capture rate means nothing without it. */
const estimateRule: React.CSSProperties = {
	position: 'absolute',
	top: 0,
	bottom: 0,
	width: 1,
	background: mark('estimate.rule'),
}

/** How wide the sample leaves this estimate. */
const estimateInterval: React.CSSProperties = {
	position: 'absolute',
	top: 6,
	height: 6,
	borderRadius: 3,
	background: mark('estimate.interval'),
}

/** The estimate itself. Its own boundary, which is why the interval may sit under 3:1. */
const estimateDot: React.CSSProperties = {
	position: 'absolute',
	top: 4,
	width: 10,
	height: 10,
	marginLeft: -5,
	borderRadius: '50%',
	background: mark('estimate.dot'),
}










/** A ratio and its toggle, sharing a baseline. */
const ratioRow: React.CSSProperties = {
	display: 'flex',
	alignItems: 'baseline',
	gap: SPACE.block,
	flexWrap: 'wrap',
}

/** The control that turns a ratio over. Quiet: it is an affordance, not a finding. */
const ratioToggle: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.22))',
	borderRadius: 3,
	color: 'inherit',
	font: 'inherit',
	fontSize: '0.72em',
	padding: '1px 7px',
	cursor: 'pointer',
	opacity: 0.75,
}

/** The filter box. */
const filterInput: React.CSSProperties = {
	font: 'inherit',
	fontSize: '0.85em',
	padding: '4px 8px',
	borderRadius: 3,
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.22))',
	background: 'transparent',
	color: 'inherit',
	minWidth: 160,
}

/** A control sitting alongside a table, e.g. the CSV copy. */
const tableControlButton: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.22))',
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
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.22))',
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
export const visuallyHidden: React.CSSProperties = {
	position: 'absolute',
	width: 1,
	height: 1,
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap',
}
