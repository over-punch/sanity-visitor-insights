/**
 * The report panels.
 *
 * Every panel renders a table or labelled bars rather than a chart, and every one surfaces its own
 * caveats inline. Tables are the accessible representation as well as the visual one, so there is
 * no separate "view as data" toggle that could drift out of sync with what is displayed.
 *
 * Every array these panels read is accessed defensively, and that is not paranoia about the server.
 * The Studio bundle and the site's API route are separate deployments on separate schedules: a
 * Studio can be upgraded while its route still runs an older package, and then a field added in the
 * newer version simply is not in the response. On 2026-09-01 a Studio on 0.8.0 read `data.daily`
 * from a route still on 0.6.2 and took the whole tool down with "Cannot read properties of
 * undefined". A panel must degrade to showing less, never to a stack trace.
 */

import React from 'react'
import { Badge, Card, Flex, Heading, Label, Stack, Text } from '@liiift-studio/sanity-ui-compat'
import { ChartData, ComparisonBar, ContainmentBar, Delta, FunnelChart, MetricFigure, NoticeList, MIN_RATE_DENOMINATOR, ProportionChart, Section, SectionTitle, isContainment, visuallyHidden, SortableTable, formatCount, formatMoney, formatPercent, splitGrid } from './Figure'
import { CrossSourceTimeline } from './CrossSourceTimeline'
import { SEND_WINDOW_DAYS } from '../core/ranges'
import { describeRank, weeklyRank } from '../core/rank'
import type {
	AcquisitionData,
	CheckStatus,
	SourceRow,
	TypefaceInterestRow,
	DiagnosticReport,
	CrossSourceDay,
	EmailCampaign,
	JourneyData,
	JourneySegment,
	JourneyStep,
	LandingPage,
	MeasurementHealthData,
	TypefaceInterestData,
} from '../reportData'
import { ok, partial, unavailable, type MetricValue } from '../types'

/**
 * Sortable value for a metric, or null when there is nothing to sort on.
 *
 * An unavailable metric is not a zero — sorting it as one would put "never measured" at the bottom
 * of an ascending column beside genuine zeros, which is the confusion MetricValue exists to prevent.
 * SortableTable sinks nulls in both directions instead.
 */
function metricSortValue(metric: MetricValue | undefined): number | null {
	if (!metric || metric.status === 'unavailable') return null
	return Number.isFinite(metric.value) ? metric.value : null
}

/**
 * Read a metric field that may not exist in the response at all.
 *
 * The Studio bundle and the site's API route deploy on separate rails, so a Studio can be several
 * versions ahead of the route it calls — Darden's Studio was on 0.13.1 while its production route
 * still resolved 0.6.x. Every field added since then arrives as `undefined`, and reading `.status`
 * on it threw inside a sort comparator, which meant the panel rendered nothing at all rather than
 * rendering without one column.
 *
 * Array fields were already guarded with `?? []`. Metric fields were not, and this is the guard
 * they needed.
 *
 * @param metric - the possibly-absent field
 * @param detail - what to say when it is absent
 */
function metricOr(metric: MetricValue | undefined, detail: string): MetricValue {
	if (metric) return metric
	return { status: 'unavailable', reason: 'route_outdated', detail }
}

/** What an absent field means: the route predates the field, not the site lacking the data. */
// Phrased for the reader, who does not deploy anything. The action belongs to whoever maintains
// the site, and naming it as theirs rather than issuing it as an instruction is the difference
// between information and a task nobody in the room can do.
const OLDER_ROUTE = 'This site\u2019s analytics route is older than this figure — it will appear after the site is next deployed.'

/** Largest available value across metrics, for scaling bars. */
function maxOf(metrics: MetricValue[]): number {
	return metrics.reduce((max, metric) => (metric.status === 'unavailable' ? max : Math.max(max, metric.value)), 0)
}


/**
 * Section headings.
 *
 * The UI kit's Heading carries no margin of its own and relies on Stack spacing, which the compat
 * shim drops when it falls back — so headings sat directly on the section above and read as part
 * of it. An explicit top margin and a little breathing room below make each section legible as a
 * section regardless of what the shim resolves.
 */
const sectionHeading: React.CSSProperties = { margin: '0 0 2px', lineHeight: 1.3 }

/**
 * A usable number, or null.
 *
 * Narrower than a `!== null` check, which lets `undefined` through — and `undefined` is exactly
 * what an older API route sends for a field added since it was deployed. `formatPercent(undefined)`
 * then renders "NaN%" in the largest type on the panel.
 */
function finiteOrNull(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Identity for a source row: every dimension the report groups by. */
function acquisitionRowKey(row: SourceRow): string {
	return [row.source, row.channel, row.medium ?? '', row.campaign ?? ''].join(' \u203a ')
}

/** A figure with its period-over-period delta alongside, wrapping on a narrow pane. */
const figureRow: React.CSSProperties = {
	display: 'flex',
	alignItems: 'baseline',
	gap: 10,
	flexWrap: 'wrap',
}

/** Referrer links, marked as links without shouting. */
/** The segment control: one row of options, wrapping on a narrow pane. */
const segmentRow: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }

/** Column head in the segment table. Quiet, because the step names are the content. */
const segmentHeadCell: React.CSSProperties = {
	textAlign: 'left',
	fontSize: '0.78em',
	letterSpacing: '0.06em',
	textTransform: 'uppercase',
	fontWeight: 500,
	opacity: 0.7,
	padding: '8px 12px',
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.3))',
	whiteSpace: 'nowrap',
}

/** A cell in the segment table. */
const segmentRowCell: React.CSSProperties = {
	textAlign: 'left',
	fontWeight: 400,
	padding: '8px 12px',
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.18))',
	verticalAlign: 'baseline',
}

const sourceLink: React.CSSProperties = {
	color: 'inherit',
	textDecoration: 'underline',
	textUnderlineOffset: 3,
	textDecorationThickness: 1,
}

/**
 * Whether a GA4 source value is a real host worth linking.
 *
 * GA4's own buckets — (direct), (not set), (none) — look like sources in the table and are not
 * destinations. Linking them would produce a dead https://(direct) that erodes trust in every other
 * link on the page.
 */
function isLinkableHost(source: string): boolean {
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(source)
}

/**
 * Card row that reflows by available width rather than by viewport breakpoints.
 *
 * The Studio panel is a resizable pane inside a Studio inside, sometimes, an iframe — its width has
 * little to do with the viewport, so `columns={[1, 3]}` was answering the wrong question. auto-fit
 * with a minimum also survives the compat shim falling back to a plain div, where a column token
 * would mean nothing.
 */
const cardGrid: React.CSSProperties = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
	gap: 16,
}

/**
 * How many pageviews GA4 did not see on a day, or null when either side is unmeasured.
 *
 * Null rather than zero: a day one source did not report is not a day they agreed. Negative is
 * kept, not clamped — GA4 counting MORE than Vercel is a real and diagnosable state (a tag firing
 * twice), and hiding it behind a floor of zero would make the two failure modes look identical.
 *
 * @param day - one day of the cross-source series
 */
export function gapOf(day: { vercelPageviews: number | null; ga4Pageviews: number | null }): number | null {
	if (day.vercelPageviews === null || day.ga4Pageviews === null) return null
	return day.vercelPageviews - day.ga4Pageviews
}

/**
 * The fraction of a day's pageviews GA4 saw, or null when it cannot be computed.
 *
 * Null on a zero denominator as well as on a missing measurement: no traffic means no coverage
 * figure, and 0/0 rendered as 0% would put the quietest days at the top of a sort meant to find
 * the worst ones.
 *
 * @param day - one day of the cross-source series
 */
export function coverageOf(day: { vercelPageviews: number | null; ga4Pageviews: number | null }): number | null {
	if (day.vercelPageviews === null || day.ga4Pageviews === null || day.vercelPageviews <= 0) return null
	return day.ga4Pageviews / day.vercelPageviews
}

/**
 * Overview — the five-minute read.
 *
 * Revenue, orders, the mailing list, the cross-source timeline and the campaign table all used to
 * live on a tab called "Measurement health", whose own blurb announced it was about how much of
 * reality each source sees. Four of the five questions a foundry owner opens this for were filed
 * under plumbing, on tab four, behind a door labelled for the instrument. This is the same data,
 * first, under a heading that says what it is.
 */
export function OverviewPanel({ data, previous, onBrush }: {
	data: MeasurementHealthData
	previous?: MeasurementHealthData
	/** Narrow every panel to a span dragged on the timeline. */
	onBrush?: (start: string, end: string) => void
}): React.ReactElement {
	return (
		<Stack space={4}>
			<Verdict data={data} previous={previous} />

			<div style={cardGrid}>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Revenue</Label>
						<div style={figureRow}>
							{metricOr(data.revenue, OLDER_ROUTE).status === 'ok'
								? <Text size={4}>{formatMoney((data.revenue as { value: number }).value, data.currency ?? null)}</Text>
								: <MetricFigure metric={metricOr(data.revenue, OLDER_ROUTE)} label="Revenue" />}
							<Delta current={metricSortValue(data.revenue)} previous={metricSortValue(previous?.revenue)} />
						</div>
						{/* The rank, beside the change rather than instead of it.
						
						    A percentage on these counts is the part that misleads — seven orders
						    against four is "+75%" and moves twenty-five points on one more sale —
						    but the change is still what a reader looks for first, so it stays. The
						    rank is what tells them whether the week was normal, which the percentage
						    never could. Exact quantities only: ranking a GA4 figure would rank the
						    instrument's mood alongside the business. */}
						{rankLine(data.crossSource, (d) => d.revenue) && (
							<Text size={0} muted>{rankLine(data.crossSource, (d) => d.revenue)}</Text>
						)}
					</Stack>
				</Card>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Orders</Label>
						<div style={figureRow}>
							<MetricFigure metric={data.orders} label="Orders" />
							<Delta current={metricSortValue(data.orders)} previous={metricSortValue(previous?.orders)} />
						</div>
						{rankLine(data.crossSource, (d) => d.orders) && (
							<Text size={0} muted>{rankLine(data.crossSource, (d) => d.orders)}</Text>
						)}
					</Stack>
				</Card>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Traffic</Label>
						{/* The verdict asserts a traffic move; without this card the reader was told a
						    number changed and shown no number. Vercel's, because it is the complete
						    one — GA4's sessions differ from it by 86% on Darden. */}
						<div style={figureRow}>
							<MetricFigure metric={metricOr(data.vercelPageviews, OLDER_ROUTE)} label="Pageviews" />
							<Delta current={metricSortValue(data.vercelPageviews)} previous={metricSortValue(previous?.vercelPageviews)} />
						</div>
						<Text size={0} muted>Pageviews, from Vercel’s own counter.</Text>
					</Stack>
				</Card>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						{/* "Total", in the label, because this card sits in a row with Revenue, Orders and
						    Traffic — all scoped to the selected range — while it alone is Mailchimp's
						    current all-time count. On a Week range the growth line beneath is withheld
						    (Mailchimp reports growth by calendar month), so the card was a lifetime
						    figure standing unlabelled beside three period figures. */}
						<Label size={1} muted>Mailing list, total</Label>
						<div style={figureRow}>
							<MetricFigure metric={metricOr(data.audience, OLDER_ROUTE)} label="Mailing list members" />
							{/* audienceGrowth, not a delta between windows. `member_count` is Mailchimp's
							    CURRENT total and carries no date filter, so it is identical in this
							    envelope and the comparison one — the delta was structurally always
							    "no change", teaching the reader their list never moves, while the real
							    net change was computed server-side and rendered nowhere. */}
							{(() => {
								// Rendered directly. audienceGrowth is ALREADY the net change, so passing
								// it to Delta with a baseline of 0 printed "new from 0" on an established
								// list of four thousand people.
								const growth = metricSortValue(data.audienceGrowth)
								if (growth === null) {
									/*
									 * Absent SAYS why, rather than rendering nothing.
									 *
									 * `metricSortValue` returns null for any unavailable metric, so the reason
									 * the server took care to write — "Mailchimp reports list growth by
									 * calendar month, so this range has no start figure" — was discarded. And
									 * the start figure is only fetched when the range begins on the first of a
									 * month, which no preset range does. So on every range the card showed a
									 * bare total and nothing else, forever, and a foundry whose largest asset
									 * is its list would conclude the tool does not do growth.
									 *
									 * This is the one card that bypasses MetricFigure, which is exactly where
									 * the absent-versus-zero rule stopped being applied.
									 */
									const reason = data.audienceGrowth?.status === 'unavailable'
										? data.audienceGrowth.detail
										: null
									return reason ? <Text size={0} muted>{reason}</Text> : null
								}
								return (
									<Text size={1} muted>
										{growth > 0 ? '+' : ''}{formatCount(growth)} this period
									</Text>
								)
							})()}
						</div>
						<Text size={0} muted>
							Everyone subscribed today, not just this period. Mailchimp&rsquo;s own count, so it is
							not consent-gated or blockable.
						</Text>
					</Stack>
				</Card>
			</div>

			{/*
			  * The two ratios a foundry would quote, which the tool held both halves of and never
			  * divided. Revenue and Orders sat in adjacent cards; sessions and orders sat on adjacent
			  * tabs. Derived here, so neither costs a query.
			  */}
			<div style={cardGrid}>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Average order</Label>
						{(() => {
							const average = averageOrderValue(data)
							const value = metricSortValue(average)
							if (value === null) return <MetricFigure metric={average} label="Average order value" />
							return (
								<Stack space={2}>
									<div style={figureRow}>
										<Text size={4}>{formatMoney(value, data.currency ?? null)}</Text>
									</div>
									{/* The denominator, not the bare word `partial`.
									
									    averageOrderValue already builds "Averaged over the 2 of 7 orders
									    that carry an amount" — and this card threw it away, printing one
									    lowercase word instead, because it bypasses MetricFigure to format
									    currency. A reader could not tell whether $455 was their average
									    order or the average of two of them. Those are different
									    businesses, and the tool refuses to rank a typeface on 28 views
									    while it was happy to state this one unqualified. */}
									{average.status === 'partial' && average.note && (
										<Text size={0} muted>{average.note}</Text>
									)}
								</Stack>
							)
						})()}
						<Text size={0} muted>
							{/* The denominator moved into the figure above, where it belongs. This caption
							    used to carry it in prose as well. */}
							From your orders, so exact.
						</Text>
					</Stack>
				</Card>

				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Visitors per order</Label>
						<MetricFigure metric={visitorsPerOrder(data)} label="Visitors per order" />
						<Text size={0} muted>
							Against Vercel&rsquo;s visitor count, not Google Analytics&rsquo; — dividing by GA4
							would flatter this by whatever share it is missing. Read it as a ceiling: some of
							those visitors are crawlers or repeat devices.
						</Text>
					</Stack>
				</Card>
			</div>

			{(data.crossSource?.length ?? 0) >= 3 && (
				<Stack space={3}>
					<SectionTitle title="Everything, on one time axis" />
					{/* Forty words defending a design decision to a reader who never proposed the
					    alternative had escaped from a code comment into the UI. What the reader needs
					    is how to read the chart, not why it was drawn this way. */}
					<Text size={1} muted>
						Each row has its own scale. Hover a day, or use the control below, to see what each
						source saw of it.
					</Text>
					<CrossSourceTimeline
						onBrush={onBrush}
						currency={data.currency ?? null}
						markers={data.timelineEvents ?? []}
						series={[
							{
								// One traffic row, not two. The line is what happened; GA4's view of it
								// is the shaded area beneath. Two peer lines made the reader reconcile
								// before getting an answer, and GA4 is not a competing estimate of
								// pageviews — it is a lossy subset of them.
								key: 'traffic',
								label: 'Pageviews',
								source: 'Vercel',
								complete: true,
								unit: 'count',
								points: (data.crossSource ?? []).map((d) => ({ date: d.date, value: d.vercelPageviews })),
								// The same row last period, so the reader can see whether this shape is normal.
								comparison: (previous?.crossSource ?? []).map((d) => ({ date: d.date, value: d.vercelPageviews })),
								shortfall: {
									label: 'Seen by GA4',
									source: 'GA4',
									// PAGEVIEWS, not sessions. The region encodes the difference between
									// these two as an area, so both sides must be the same unit — this
									// previously shaded sessions under a pageview line, overstating the
									// loss by the pageviews-per-session ratio.
									points: (data.crossSource ?? []).map((d) => ({ date: d.date, value: d.ga4Pageviews })),
								},
							},
							/*
							 * Coverage as its own row, on a fixed 0–100% axis.
							 *
							 * The shaded band under the traffic line is an ABSOLUTE quantity — Vercel
							 * minus GA4 — so under a flat 20% coverage it is 0.8 times the traffic curve
							 * and tracks it exactly. Every busy day therefore shows a wider alarm than
							 * every quiet day with no change whatever in the instrument, and the one
							 * distinction this tool exists to draw — a standing shortfall against a dated
							 * collapse — is the one the encoding could not show. It had to be asserted in
							 * prose by a detector instead, which made that sentence the reader's only
							 * witness to its own subject.
							 *
							 * As a proportion it draws itself: a standing shortfall is a flat line, a
							 * collapse is a step with a date under it, a gradual decay is a ramp that
							 * plainly is not an event, and a partial recovery is a line that visibly did
							 * not return. The reader can check the sentence rather than trust it.
							 */
							...((data.crossSource ?? []).some((d) => d.vercelPageviews !== null && d.ga4Pageviews !== null)
								? [{
									key: 'coverage',
									label: 'Share GA4 saw',
									source: 'GA4' as const,
									complete: true,
									unit: 'percent' as const,
									// Fixed, not scaled to its own best day — otherwise a site at a flat 20%
									// draws a full-height line and reads as healthy.
									domain: [0, 1] as [number, number],
									points: (data.crossSource ?? []).map((d) => ({
										date: d.date,
										value: d.vercelPageviews !== null && d.ga4Pageviews !== null && d.vercelPageviews > 0
											? Math.min(1, d.ga4Pageviews / d.vercelPageviews)
											: null,
									})),
									// The most valuable ghost in the chart: a collapse reads as a step away
									// from last period's flat line, whether or not the detector fired.
									comparison: (previous?.crossSource ?? []).map((d) => ({
										date: d.date,
										value: d.vercelPageviews !== null && d.ga4Pageviews !== null && d.vercelPageviews > 0
											? Math.min(1, d.ga4Pageviews / d.vercelPageviews)
											: null,
									})),
								}]
								: []),
							...(data.crossSource?.some((d) => d.revenue !== null)
								? [{
									key: 'revenue',
									label: 'Revenue',
									source: 'Sanity' as const,
									complete: true,
									unit: 'money' as const,
									// A sale is an event on a date, not a level that varies day to day.
									mark: 'events' as const,
									points: (data.crossSource ?? []).map((d) => ({ date: d.date, value: d.revenue })),
								}]
								: [{
									key: 'orders',
									label: 'Orders',
									source: 'Sanity' as const,
									complete: true,
									unit: 'count' as const,
									mark: 'events' as const,
									points: (data.crossSource ?? []).map((d) => ({ date: d.date, value: d.orders })),
								}]),
						]}
					/>

					{data.vercelDailyUnavailable && (
						// Restored. Vercel's aggregate endpoint caps at 62 day-buckets, so on Quarter and
						// Year the pageview row has no data at all — and the sentence explaining that was
						// deleted along with the "Day by day" section when this panel was split, leaving
						// two of the four ranges drawing an empty band under "Everything, on one time
						// axis" on the default tab with nothing to say why.
						<Text size={1} muted>
							Vercel reports a range this long in weekly buckets, so the pageview row is empty
							here. Choose Week or Month to see it.
						</Text>
					)}

					<ChartData<CrossSourceDay>
						// No note. "A negative miss means GA4 counted more than Vercel that day —
						// usually a tag firing twice" was the THIRD copy of that sentence on one
						// screen: the timeline's caution card says it against a live finding, and the
						// over-count notice says it again beside the capture estimates. A reader who
						// meets a claim three times stops reading the register it arrives in. It
						// stays where it is attached to something that actually happened.
						label="Show these figures as a table"
						rows={data.crossSource ?? []}
						rowKey={(d) => d.date}
						exportName="timeline"
						// Filterable, like every other table in the tool. This one carries the columns
						// the whole package exists for and was the only table with no filter box.
						filterOn={(d) => d.date}
						columns={[
							{ key: 'date', label: 'Date', sortValue: (d) => d.date, render: (d) => <Text size={1}>{d.date}</Text> },
							{
								key: 'vercel', label: 'Pageviews', numeric: true,
								sortValue: (d) => d.vercelPageviews,
								render: (d) => <Text size={1}>{d.vercelPageviews === null ? '—' : formatCount(d.vercelPageviews)}</Text>,
							},
							{
								key: 'ga4', label: 'Seen by GA4', numeric: true,
								sortValue: (d) => d.ga4Pageviews,
								render: (d) => <Text size={1}>{d.ga4Pageviews === null ? '—' : formatCount(d.ga4Pageviews)}</Text>,
							},
							{
								/*
								 * The disagreement, as a number you can sort on.
								 *
								 * This table held `Pageviews` and `Seen by GA4` as separate columns and
								 * nothing joining them, so the one quantity this whole tool exists to
								 * surface was the one column missing from the only table that could hold
								 * it. "Which day did GA4 lose most" was answerable by eye, or by the
								 * single worst-day sentence under the chart, and by nothing else — not
								 * sortable, not filterable, not in the CSV.
								 */
								key: 'missed', label: 'Missed by GA4', numeric: true,
								sortValue: (d) => gapOf(d),
								render: (d) => {
									const gap = gapOf(d)
									return <Text size={1}>{gap === null ? '—' : formatCount(gap)}</Text>
								},
							},
							{
								/*
								 * The same disagreement as a proportion, because the two rank days
								 * differently and both questions are real: the absolute column finds the
								 * day that cost the most, this one finds the day the instrument worked
								 * worst. Sorting on it is how a reader dates a collapse.
								 */
								key: 'coverage', label: 'Share GA4 saw', numeric: true,
								sortValue: (d) => coverageOf(d),
								// The FORMATTED value, matching the cell. Passing the raw ratio through
								// shipped 0.06666666666666667 into a CSV column whose cell reads "7%" —
								// verbatim the case exportValue exists to prevent.
								exportValue: (d) => {
									const coverage = coverageOf(d)
									return coverage === null ? null : formatPercent(coverage, 0)
								},
								render: (d) => {
									const coverage = coverageOf(d)
									return <Text size={1}>{coverage === null ? '—' : formatPercent(coverage, 0)}</Text>
								},
							},
							{
								key: 'orders', label: 'Orders', numeric: true,
								sortValue: (d) => d.orders,
								render: (d) => <Text size={1}>{d.orders === null ? '—' : formatCount(d.orders)}</Text>,
							},
							{
								key: 'revenue', label: 'Revenue', numeric: true,
								sortValue: (d) => d.revenue,
								exportValue: (d) => (d.revenue === null ? null : formatMoney(d.revenue, data.currency ?? null)),
								render: (d) => <Text size={1}>{d.revenue === null ? '—' : formatMoney(d.revenue, data.currency ?? null)}</Text>,
							},
						]}
					/>
				</Stack>
			)}


			{(data.campaigns?.length ?? 0) > 0 && (
				<Stack space={3}>
					<SectionTitle title="Email campaigns" />
					<Text size={1} muted>
						Clicks are distinct subscribers. Opens are not shown: Apple Mail fetches images on
						the recipient&rsquo;s behalf, so an open is often the mail client rather than a person.
					</Text>
					{/* Said once, above the table, rather than in a tooltip on every cell. The claim these
					    columns do NOT make is the important half, and a reader who takes "after" for
					    "because of" will over-credit the newsletter. */}
					<Text size={1} muted>
						The last two columns count what your order book records in the {SEND_WINDOW_DAYS} days
						after each send, ending early if another send lands first. They are what happened
						next, not what the send caused &mdash; but unlike anything GA4 can tell you about
						email, both the send times and the order times are exact.
					</Text>
					<SortableTable<EmailCampaign>
						caption="Email campaigns by clicks"
						initialSort="clicks"
						rows={data.campaigns ?? []}
						rowKey={(c) => `${c.sentAt}-${c.title}`}
						filterOn={(c) => `${c.title} ${c.subject}`}
						filterPlaceholder="Filter campaigns"
						exportName="email-campaigns"
						columns={[
							{
								key: 'title',
								label: 'Campaign',
								sortValue: (c) => c.title,
								render: (c) => (
									<Stack space={1}>
										<Text size={1}>{c.title}</Text>
										<Text size={0} muted>{c.sentAt.slice(0, 10)}</Text>
									</Stack>
								),
							},
							{ key: 'sent', label: 'Sent', numeric: true, sortValue: (c) => c.sent, render: (c) => <Text size={1}>{formatCount(c.sent)}</Text> },
							// No Opens column. The caption above the table told the reader, in the tool's
							// own words, to "sort on clicks, not opens" because Apple Mail Privacy
							// Protection fetches images on the recipient's behalf. A column whose own
							// caption instructs you not to read it should not be a column — and the
							// warning gets shorter as a result.
							{ key: 'clicks', label: 'Clicks', numeric: true, sortValue: (c) => c.clicks, render: (c) => <Text size={1}>{formatCount(c.clicks)}</Text> },
							{
								key: 'unsub',
								label: 'Unsubscribed',
								numeric: true,
								sortValue: (c) => c.unsubscribed,
								render: (c) => <Text size={1} muted>{formatCount(c.unsubscribed)}</Text>,
							},
							{
								key: 'ordersAfter',
								label: 'Orders after',
								numeric: true,
								sortValue: (c) => c.ordersAfter ?? null,
								exportValue: (c) => c.ordersAfter ?? null,
								render: (c) => (
									<Text size={1}>
										{c.ordersAfter === null || c.ordersAfter === undefined ? '—' : formatCount(c.ordersAfter)}
										{/* A send on the last day of the range has not had its days yet. Without
										    this it reads as a campaign that sold nothing, which is a conclusion
										    about the campaign drawn from the shape of the window. */}
										{c.windowComplete === false && c.ordersAfter !== null && c.ordersAfter !== undefined && (
											<Text as="span" size={0} muted> so far</Text>
										)}
									</Text>
								),
							},
							{
								key: 'revenuePerThousand',
								label: 'Per 1,000 sent',
								numeric: true,
								// Per thousand, not per send: a foundry's sends run to thousands of addresses
								// against a handful of orders, so per-send lands at fractions of a cent and
								// every campaign renders as the same rounded zero.
								sortValue: (c) => revenuePerThousandSent(c),
								exportValue: (c) => revenuePerThousandSent(c),
								render: (c) => {
									const value = revenuePerThousandSent(c)
									return (
										<Text size={1}>
											{value === null ? '—' : formatMoney(value, data.currency ?? null)}
										</Text>
									)
								},
							},
						]}
					/>
				</Stack>
			)}

		</Stack>
	)
}

/**
 * One line saying whether this week was normal.
 *
 * Every input was already computed and the reader was left to derive the conclusion themselves,
 * from levels, across four tabs, by comparing arrows. For someone with five minutes on a Monday
 * that derivation IS the work, and the tool was making them do all of it.
 */
function Verdict({ data, previous }: { data: MeasurementHealthData; previous?: MeasurementHealthData }): React.ReactElement | null {
	const parts: string[] = []

	const say = (label: string, now: MetricValue | undefined, before: MetricValue | undefined, unit: 'money' | 'count') => {
		const a = metricSortValue(now)
		const b = metricSortValue(before)
		if (a === null) return
		if (b === null || b === 0) {
			parts.push(`${label} ${unit === 'money' ? formatMoney(a, data.currency ?? null) : formatCount(a)}`)
			return
		}
		const change = (a - b) / Math.abs(b)
		/*
		 * "Flat" carries its number when there is one.
		 *
		 * Two definitions of flat sat ten pixels apart on the same panel: this line called a move
		 * under 5% flat, while the card beneath it drew an arrow above 0.5% — so the headline could
		 * read "Traffic flat" in the largest type directly above a Traffic card reading "↑ +4% from
		 * 2,266". The suppression is still right at these volumes; contradicting the card was not.
		 * Saying "little changed (+4%)" keeps the judgement and agrees with what is on screen.
		 */
		if (Math.abs(change) < 0.05) {
			parts.push(Math.abs(change) < 0.005
				? `${label} flat`
				: `${label} little changed (${change > 0 ? '+' : '−'}${formatPercent(Math.abs(change), 0)})`)
		}
		/*
		 * A money move carries its amounts, and a percentage alone is suppressed on thin volumes.
		 *
		 * "Revenue down 62%" was printed in the largest type on the page. At two orders a month that
		 * is one order not landing, and the card beneath — which does print its baseline — is smaller
		 * and read second. Every neighbouring component already knows this: Delta's own comment says
		 * an 18% move might be one order, and the typeface blurb says a family with one or two sales
		 * swings a long way. The headline was the one place that skipped it.
		 */
		else if (unit === 'money') {
			parts.push(`${label} ${change > 0 ? 'up' : 'down'} to ${formatMoney(a, data.currency ?? null)} from ${formatMoney(b, data.currency ?? null)}`)
		}
		else parts.push(`${label} ${change > 0 ? 'up' : 'down'} ${formatPercent(Math.abs(change), 0)}`)
	}

	say('Revenue', data.revenue, previous?.revenue, 'money')
	say('Traffic', data.vercelPageviews, previous?.vercelPageviews, 'count')

	const sends = data.campaigns?.length ?? 0
	// Not a verdict clause. That you sent an email is not a finding — you sent it — and it was
	// occupying a slot in the one line the reader is meant to act on. The campaigns table below
	// says how many, and the timeline marks when.

	// What "broken" means, in priority order.
	//
	// This used to consult `capture.discrepancy` alone — which is null whenever fewer than two
	// capture estimates exist, and at seven orders a quarter the orders and email estimates are
	// almost always below their minimum denominator on a Week range. So the only surviving estimate
	// was pageviews, the discrepancy was null, and the line appended "nothing broken".
	//
	// The 24 August collapse — an 86% shortfall running ten days, the founding failure this whole
	// package cites — would therefore have read, on a Monday: "Revenue flat · traffic flat ·
	// nothing broken". The figure that names it was computed and rendered two tabs away.
	// Graded, not a single cliff at 0.6. The threshold was one hard step, so a site where GA4 saw
	// 45% of its traffic — less than half — got a clean bill of health in the largest type on the
	// default tab, and a twelve-day collapse inside a ninety-day quarter averaged down below the
	// line and vanished entirely.
	const shortfall = data.shortfallRatio
	const seeing = shortfall !== null && shortfall !== undefined
		? `GA4 is seeing ${formatPercent(1 - shortfall, 0)} of your traffic`
		: null
	const broken = shortfall === null || shortfall === undefined
		? (data.capture?.discrepancy ? 'measurement disagrees between sources' : null)
		: shortfall > 0.6
			? `${seeing} — treat its figures as broken`
			: shortfall > 0.35
				? `${seeing} — its figures are undercounts, not what happened`
				: data.capture?.discrepancy
					? 'measurement disagrees between sources'
					: null
	if (broken) parts.push(broken)

	if (parts.length === 0) return null

	// "Nothing broken" needs a positive test, not the absence of a warning. It used to be appended
	// whenever `capture.discrepancy` was falsy — which includes capture being absent entirely, so an
	// older route or an unconfigured site printed a confident all-clear on no evidence at all.
	// No closing claim at all.
	//
	// This used to append "· nothing broken" — a statement about the site, the checkout, the orders
	// and four other tabs, resting on a single ratio about Google Analytics. It read as "the
	// business is fine". Between a fifth and a third of loss the coverage is worth STATING, because
	// it is a real qualifier on the traffic figure beside it, but it is not a verdict; below that,
	// silence. Silence here means nothing was flagged, which is all this line ever knew.
	const noticeable = shortfall !== null && shortfall !== undefined && shortfall > 0.2
	const closing = broken || !noticeable ? '' : ` · ${seeing}`

	return (
		<Card
			padding={3}
			radius={2}
			tone={broken ? 'caution' : 'transparent'}
			border
			// An explicit border alongside the tone: the compat shim's fallback drops `tone`, and
			// this card is the tool's only alarm. Losing its colour must not lose the signal.
			style={broken ? { borderLeftWidth: 3, borderLeftStyle: 'solid' } : undefined}
		>
			{/* size={3}, not size={2}. It was set one step above body and SMALLER than the figures
			    beneath it, so the panel's thesis read as a caption for the cards. */}
			<Text size={3} weight={broken ? 'semibold' : 'medium'}>{parts.join(' · ')}{closing}</Text>
		</Card>
	)
}

/**
 * Data health — the instrument, deliberately last.
 *
 * Everything here answers one question: can I trust the numbers on the other tabs. It was two
 * separate tabs answering that question, which is one more than it deserves out of five.
 */
export function DataHealthPanel({ data, diagnostics }: { data: MeasurementHealthData; diagnostics?: DiagnosticReport }): React.ReactElement {
	const pageviewMax = maxOf([data.ga4Pageviews, data.vercelPageviews])
	// Whether a part-inside-whole bar is honest here — see the comment at the render site.
	const contained = isContainment(data.vercelPageviews, data.ga4Pageviews)

	return (
		<Stack space={4}>
			<Stack space={3}>
				<SectionTitle title="Pageviews, source against source" />
				<Text size={1} muted>
					Both counting pageviews. Google Analytics is blockable, so seeing fewer is normal.
				</Text>
				{/* One bar, because this is a part inside a whole and not two rivals.
				
				    As two peer bars scaled to the larger of the pair, Vercel's was full width on
				    every site and every range — no information at all — and a caption had to say in
				    words that the other was "a subset of the bar above, not a rival measurement".
				    The encoding asserted the opposite of the truth and the prose took it back.
				
				    ContainmentBar returns null where the part exceeds the whole, which is real:
				    GA4 counts more than Vercel wherever Vercel's collection started after the range
				    began. There the two-bar form is still the honest picture, so it is kept as the
				    fallback rather than forcing a containment that does not hold. */}
				{contained ? (
					<ContainmentBar
						wholeLabel="Pageviews Vercel counted"
						whole={data.vercelPageviews}
						partLabel="Seen by Google Analytics"
						part={data.ga4Pageviews}
						missingLabel="it missed"
					/>
				) : (
					<>
						<ComparisonBar label="Vercel pageviews" metric={data.vercelPageviews} max={pageviewMax} />
						<ComparisonBar label="GA4 pageviews" metric={data.ga4Pageviews} max={pageviewMax} />
					</>
				)}
			</Stack>

			{/* The reading is always shown. It used to be nested inside the shortfall block, so a
			    range where only one source answered rendered bare numbers and no explanation of why
			    there was nothing to compare — the state where the explanation matters most. */}
			<Card padding={3} radius={2} tone="transparent" border>
				<Stack space={2}>
					{data.shortfallRatio !== null && (
						<Text size={1} weight="semibold">
							{/* Named by direction rather than always as a GA4 shortfall. The ratio goes
							    negative whenever GA4 sees more than Vercel — routine where Vercel's
							    collection started later than the range, as on MCKL — and the label used
							    to read "GA4 shortfall" over an absolute value, stating the opposite of
							    the truth while the sentence below it said "more". */}
							{data.shortfallRatio >= 0
								? `GA4 saw ${formatPercent(data.shortfallRatio, 1)} fewer pageviews than Vercel`
								: `GA4 saw ${formatPercent(-data.shortfallRatio, 1)} more pageviews than Vercel`}
						</Text>
					)}
					<Text size={1} muted>{data.interpretation}</Text>
				</Stack>
			</Card>

			{((data.capture?.estimates?.length ?? 0) > 0 || data.estimatedSessions?.status === 'estimated') && (
				<Stack space={3}>
					<SectionTitle title="How much GA4 is seeing" />
					<div style={cardGrid}>
						{(data.capture?.estimates ?? []).map((estimate) => (
							<Card key={estimate.basis} padding={3} radius={2} tone="transparent" border>
								<Stack space={3}>
									<Label size={1} muted>
										{estimate.basis === 'orders' ? 'Checked against your orders'
											: estimate.basis === 'email' ? 'Checked against email clicks'
												: 'Checked against Vercel'}
									</Label>
									{/* Unclamped. `Math.min(1, …)` rendered a tag reporting 250% of reality as a
									    flat 100% under the heading "How much GA4 is seeing" — i.e. perfect —
									    and over-counting is a real failure this package has a whole
									    interpretation branch for. It is also the one case where the corrected
									    figures silently disappear, because grossUp returns null above a rate
									    of 1, so hiding its cause left the reader with no explanation. */}
									<Text size={4}>{formatPercent(estimate.rate, 0)}</Text>
									{estimate.rate > 1.05 && (
										<Text size={0}>
											Above 100%: GA4 is counting more than the source it is measured against.
											That is usually a tag firing twice, not extra traffic.
										</Text>
									)}
									<Text size={0} muted>
										{formatCount(estimate.observed)} of {formatCount(estimate.actual)}. {estimate.note}
									</Text>
								</Stack>
							</Card>
						))}
					</div>

					{/* The point of holding three estimates. Rendered in caution tone because a
					    disagreement is a finding, not context. */}
					{data.capture?.discrepancy && (
						<Card padding={3} radius={2} tone="caution" border>
							<Stack space={2}>
								<Text size={1} weight="medium">The sources disagree, and that is informative</Text>
								<Text size={1}>{data.capture.discrepancy}</Text>
							</Stack>
						</Card>
					)}

					{data.estimatedSessions && data.estimatedSessions.status === 'estimated' && (
						<Card padding={3} radius={2} tone="transparent" border>
							<Stack space={3}>
								<Label size={1} muted>Sessions, corrected for what GA4 misses</Label>
								<MetricFigure metric={data.estimatedSessions} label="Estimated sessions" />
							</Stack>
						</Card>
					)}
				</Stack>
			)}


			{Object.keys(data.orderStatuses ?? {}).length > 0 && (
				<Stack space={3}>
					<SectionTitle title="Order statuses in this range" tone="secondary" />
					{/* The only place a site's own status vocabulary is visible. Without it nobody can
					    configure which statuses count as a sale — and getting that wrong zeroes every
					    order-derived figure in the tool with nothing on screen to explain it. */}
					<Text size={1} muted>
						What the orders actually say, before any filtering. Use these values to set which
						statuses count as a sale.
					</Text>
					<div style={cardGrid}>
						{Object.entries(data.orderStatuses ?? {})
							.sort((a, b) => b[1] - a[1])
							.map(([status, count]) => (
								<Card key={status} padding={3} radius={2} tone="transparent" border>
									<Stack space={3}>
										<Label size={1} muted>{status}</Label>
										<Text size={3}>{formatCount(count)}</Text>
									</Stack>
								</Card>
							))}
					</div>
				</Stack>
			)}

			<Section
				title="Context"
				tone="secondary"
				subtitle="Different units to the figures above, and to each other."
				collapsible
			>
				<div style={cardGrid}>
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>Vercel visitors</Label>
							<MetricFigure metric={metricOr(data.vercelVisitors, OLDER_ROUTE)} label="Vercel visitors" />
							{/* Not "server-side". Vercel Web Analytics is the @vercel/analytics client script
							    on a first-party path — blocked by fewer lists than GA4, and blocked. */}
							<Text size={0} muted>Vercel&rsquo;s own counter. Blocked far less often than Google Analytics, but not never — so read it as a floor on your real traffic.</Text>
						</Stack>
					</Card>
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>GA4 sessions</Label>
							<MetricFigure metric={data.ga4Sessions} label="GA4 sessions" />
						</Stack>
					</Card>
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>Consent granted</Label>
							<MetricFigure metric={data.consentRate} label="Consent granted, share of visitors GA4 saw" unit="percent" />
						</Stack>
					</Card>
				</div>
			</Section>

			{diagnostics && (
				/* Open, and primary. This is the longest block on the tab and the obvious candidate
				   for folding away — but the tab it sits on exists to answer "what should I fix
				   before trusting any of this", and these checks ARE that answer. Folding it would
				   have left Data health opening on a summary of the problem with the solution behind
				   a click. It stays collapsible so a reader who has read it can get it out of the
				   way. */
				<Section
					title="Configuration"
					subtitle="What this site has wired up, and what it is missing."
					collapsible
				>
					<DiagnosticsPanel data={diagnostics} />
				</Section>
			)}
		</Stack>
	)
}

/** Acquisition — where visitors came from, with design-industry referrers called out. */
export function AcquisitionPanel({ data, previous }: { data: AcquisitionData; previous?: AcquisitionData }): React.ReactElement {
	const designShare = finiteOrNull(data.designIndustryShare)
	const unattributedShare = finiteOrNull(data.unattributedShare)
	const sessions = finiteOrNull(data.totalSessions)

	return (
		<Stack space={4}>
			<div style={cardGrid}>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Sessions</Label>
						<div style={figureRow}>
							<Text size={4}>{sessions === null ? '\u2014' : formatCount(sessions)}</Text>
							<Delta current={sessions} previous={finiteOrNull(previous?.totalSessions)} />
						</div>
					</Stack>
				</Card>
				{designShare !== null && (
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>From design-industry referrers</Label>
							<div style={figureRow}>
								{/* "At least", when the row list is truncated. The numerator counts only the
								    rows GA4 returned while the denominator spans every row it held, and
								    design-press referrers are low-volume by nature — the population most
								    likely to sit outside the cap. The figure is a genuine floor, so it is
								    worth showing; printing it as a measurement was not. */}
								<Text size={4}>
									{data.rowsTruncated ? 'at least ' : ''}{formatPercent(designShare, 1)}
								</Text>
								{/* No delta on a floor. Two floors computed from differently truncated lists
								    are not comparable, and a percentage-point arrow between them moves when
								    a referrer crosses the row cap rather than when anything happened. */}
								{!data.rowsTruncated && (
									<Delta
										current={designShare * 100}
										previous={finiteOrNull(previous?.designIndustryShare) !== null ? (previous!.designIndustryShare as number) * 100 : null}
										unit="percent"
									/>
								)}
							</div>
							{/* Named as list-dependent. Printed bare, this figure was read as a verdict
							    on the design press when it reports the coverage of a short list. */}
							<Text size={0} muted>
								Share of sessions from a known design-press referrer.
								{data.rowsTruncated && ' GA4 held more sources than are listed here, so the real share is higher.'}
							</Text>
						</Stack>
					</Card>
				)}
				{unattributedShare !== null && (
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>No source</Label>
							<div style={figureRow}>
								<Text size={4}>{formatPercent(unattributedShare, 1)}</Text>
								<Delta
									current={unattributedShare * 100}
									previous={finiteOrNull(previous?.unattributedShare) !== null ? (previous!.unattributedShare as number) * 100 : null}
									riseIsGood={false}
									unit="percent"
								/>
							</div>
							{/* Two unlike failures used to be fused into one number. Direct traffic is
							    partly recoverable with tagging; (not set) is GA4 losing the row. */}
							<Text size={0} muted>Direct visits plus rows GA4 could not attribute.</Text>
						</Stack>
					</Card>
				)}
			</div>

			<Stack space={3}>
				<SectionTitle title="Traffic sources" />
				<Text size={1} muted>Sort, filter, or exclude a row to see what the rest looks like.</Text>
				<SortableTable<SourceRow>
					caption="Traffic sources by sessions"
					initialSort="sessions"
					rows={data.rows ?? []}
					// Every dimension the report requests, not just two of them. With medium and
					// campaign added, several rows share a source and channel — which is the point
					// of the column — and a two-part key gave duplicate React keys and made one
					// exclude click remove every row that shared it.
					rowKey={acquisitionRowKey}
					filterOn={(row) => `${row.source} ${row.channel} ${row.medium ?? ''} ${row.campaign ?? ''}`}
					filterPlaceholder="Filter sources"
					exportName="traffic-sources"
					truncatedNote={shortListNote(
						Boolean(data.rowsTruncated),
						Boolean(data.rowsWithheld),
						'For a foundry the tail of small design blogs is often the referral story.',
					)}
					columns={[
						{
							key: 'source',
							label: 'Source',
							sortValue: (row) => row.source,
							render: (row) => (
								<div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
									{/* A referrer host is a real destination, so it links. GA4's own
									    buckets — (direct), (not set) — are not hosts and must not
									    pretend to be, so only a dotted hostname gets an anchor. */}
									{/* Inside Text, not beside it. A bare anchor inherited the cell's default
									    size while the plain branch was sized by Text, so whether a source
									    linked changed how big it was — the rows read as two ranks of
									    importance when the only difference is that one is a real host.
									    The underline is what says it is a link. */}
									<Text size={1}>
										{isLinkableHost(row.source)
											? (
												<a
													href={`https://${row.source}`}
													target="_blank"
													rel="noopener noreferrer"
													style={sourceLink}
												>
													{row.source}
												</a>
											)
											: row.source}
									</Text>
									{row.designIndustry && <Badge tone="primary" fontSize={0}>Design</Badge>}
									{row.unattributed && <Badge tone="caution" fontSize={0}>No source</Badge>}
								</div>
							),
						},
						{
							key: 'channel',
							label: 'Channel',
							sortValue: (row) => row.channel,
							render: (row) => <Text size={1}>{row.channel}</Text>,
						},
						{
							key: 'campaign',
							label: 'Campaign',
							sortValue: (row) => row.campaign,
							exportValue: (row) => row.campaign ?? row.medium ?? '',
							// Every campaign, ad group and keyword used to collapse into one row, so
							// there was no unit of spend here that a buyer could pause.
							render: (row) => row.campaign
								? <Text size={1}>{row.campaign}</Text>
								: <Text size={1} muted>{row.medium ?? '—'}</Text>,
						},
						{
							key: 'sessions',
							label: 'Sessions',
							numeric: true,
							sortValue: (row) => row.sessions,
							render: (row) => <Text size={1}>{formatCount(row.sessions)}</Text>,
						},
						{
							key: 'engagement',
							label: 'Engaged',
							numeric: true,
							sortValue: (row) => finiteOrNull(row.engagementRate),
							exportValue: (row) => { const r = finiteOrNull(row.engagementRate); return r === null ? null : formatPercent(r, 0) },
							// The quality signal. Ranked by volume alone, 27 Display sessions looked
							// equal to 27 from Search, which flatters the worst line of spend.
							render: (row) => finiteOrNull(row.engagementRate) === null
								? <Text size={1} muted>—</Text>
								: <Text size={1}>{formatPercent(row.engagementRate as number, 0)}</Text>,
						},
						{
							/*
							 * What the channel BROUGHT, which is the question a foundry opens this tool
							 * with and the one it could not answer. Sessions and engagement rank
							 * channels by attention; nothing ranked them by money, so "is the design
							 * press worth chasing" and "did the newsletter sell anything" were
							 * unaskable while revenue sat one tab away, split by typeface and by
							 * licence — the two cuts already available from the order list.
							 *
							 * Sorted on the SHARE, so the ordering holds even when Sanity supplies no
							 * total and the money column is empty.
							 */
							key: 'brought',
							// The hedge belongs on the SPLIT, not on the money: the total is exact and the
							// division of it is the estimate. "(est.)" on a revenue header implied the reverse.
							label: 'Revenue, split',
							numeric: true,
							sortValue: (row) => finiteOrNull(row.revenueShare),
							exportValue: (row) => {
								const money = finiteOrNull(row.apportionedRevenue)
								return money === null ? null : formatMoney(money, data.currency ?? null)
							},
							render: (row) => {
								// finiteOrNull, not `=== null`. An older API route omits these fields
								// entirely, so they arrive as UNDEFINED — which slipped past a null check
								// and rendered "NaN% of tracked sales" in every Studio between publishing
								// this package and deploying the sites. That window is the normal state
								// of this repo, not an edge case.
								const share = finiteOrNull(row.revenueShare)
								// Zero is not a measurement here. At a fifth of traffic captured, a channel
								// with four real sales and no tracked one is the ordinary case, and it was
								// rendering a currency-formatted "$0.00 · 0% of tracked sales" — a measured
								// zero manufactured from lossy data, which is the one thing the metric types
								// in this package exist to forbid.
								if (share === null || share === 0) return <Text size={1} muted>—</Text>
								const money = finiteOrNull(row.apportionedRevenue)
								return (
									<Stack space={1}>
										{money !== null && <Text size={1}>{formatMoney(money, data.currency ?? null)}</Text>}
										<Text size={0} muted>{formatPercent(share, 0)} of tracked sales</Text>
									</Stack>
								)
							},
						},
					]}
				/>

				{data.splitIsSound === true && finiteOrNull(data.actualRevenue) !== null && (
					// Says exactly what was combined and what was estimated. The money in that column
					// is Sanity's real total spread across GA4's split — right in scale, and derived,
					// which is a different claim from measured. Saying so here is what makes the
					// column usable rather than another figure to distrust.
					<Text size={0} muted>
						Revenue is {formatMoney(finiteOrNull(data.actualRevenue) ?? 0, data.currency ?? null)} from{' '}
						{finiteOrNull(data.actualOrders) === null ? 'your orders' : `${formatCount(data.actualOrders as number)} orders`} in Sanity,
						split across the {formatCount(data.trackedPurchases ?? 0)} purchase
						{data.trackedPurchases === 1 ? '' : 's'} Google Analytics attributed to a source. Google
						Analytics sees a fraction of your traffic, so treat this as a proportion with a real total
						behind it rather than measured takings per channel. Two things to hold in mind: it credits
						whichever source a buyer arrived from on the visit they bought, which for a considered
						purchase is often a bookmark rather than the blog that first sent them; and its loss is not
						perfectly even across channels — ad-blocking runs high among designers, so earned referrals
						and direct visits are likelier to be under-credited than paid clicks.
						{finiteOrNull(data.shownPurchases) !== null && (data.shownPurchases ?? 0) < (data.trackedPurchases ?? 0) && (
							<>
								{' '}The rows above account for {formatCount(data.shownPurchases ?? 0)} of those sales; the rest
								came from sources outside this list, so this column does not add up to the whole.
							</>
						)}
					</Text>
				)}
			</Stack>

		</Stack>
	)
}

/** Journey — a funnel, drawn as a tracked sequence or as independent totals, whichever the report used. */
/**
 * How many of a segment's entrants reached the second rung.
 *
 * The single most comparable number between segments: every segment has a first step, the rate is
 * already a proportion so segments of wildly different sizes sit on one scale, and it is where a
 * foundry's funnel actually breaks. Null when the segment has fewer than two rungs or GA4 gave no
 * rate — never zero, which would rank an unmeasured segment as the worst performer.
 *
 * @param steps - one segment's rungs, in funnel order
 */
export function firstStepRate(steps: JourneyStep[]): number | null {
	const second = steps[1]
	if (!second) return null
	const rate = second.conversionFromPrevious
	return typeof rate === 'number' && Number.isFinite(rate) ? rate : null
}

/**
 * A sentence naming the gap between the best and worst segment, or null when there is not one.
 *
 * Only fires at a MULTIPLE, not a margin. Segments always differ a little, and a tool that
 * remarks on every difference teaches the reader to stop reading its remarks; three times apart is
 * the point at which the undivided funnel above stops describing either group.
 *
 * Both sides need a real denominator. At a foundry's volumes a segment of forty users can produce
 * any rate at all, and "tablet converts nine times better than desktop" off six people is the kind
 * of confident nonsense this package exists not to print.
 *
 * @param segments - every segment, in any order
 */
export function spread(segments: JourneySegment[]): string | null {
	const MIN_USERS = 200
	const RATIO = 3

	const rated = segments
		.map((segment) => ({
			label: segment.label,
			rate: firstStepRate(segment.steps),
			users: metricSortValue(segment.steps[0]?.count) ?? 0,
		}))
		.filter((row): row is { label: string; rate: number; users: number } =>
			row.rate !== null && row.rate > 0 && row.users >= MIN_USERS)

	if (rated.length < 2) return null
	const sorted = [...rated].sort((a, b) => b.rate - a.rate)
	const best = sorted[0] as { label: string; rate: number; users: number }
	const worst = sorted[sorted.length - 1] as { label: string; rate: number; users: number }
	const ratio = best.rate / worst.rate
	if (ratio < RATIO) return null

	return `${worst.label} reaches the second step at ${formatPercent(worst.rate, 2)} against `
		+ `${best.label}'s ${formatPercent(best.rate, 2)} — about ${Math.round(ratio)} times worse, on `
		+ `${formatCount(worst.users)} visitors. The combined funnel above averages the two and describes neither.`
}

/**
 * Why a table is shorter than reality, in one line.
 *
 * Two different causes used to produce two separate notices two sentences apart: `rowsTruncated`
 * (GA4 held more rows than the query's limit returned) rendered a quiet line under the table, and
 * `rowsWithheld` (GA4 suppressed low-count rows for privacy) rendered a second amber Caveat card
 * below it. The distinction is real and worth keeping in the wording — the reader's takeaway is
 * identical either way, and the same fact in two registers two lines apart is how a reader learns
 * to stop reading amber.
 *
 * Returns undefined when the list IS complete, so nothing is said. Silence is the honest default
 * here: a note that always renders carries no information.
 *
 * @param truncated - GA4 held more rows than it returned
 * @param withheld - GA4 suppressed low-count rows for privacy
 * @param tail - what the missing rows mean for this particular table
 */
export function shortListNote(truncated: boolean, withheld: boolean, tail: string): string | undefined {
	if (!truncated && !withheld) return undefined
	const cause = truncated && withheld
		? 'GA4 returned only its top rows, and withheld others with too few people to report'
		: truncated
			? 'GA4 returned only its top rows'
			: 'GA4 withheld rows with too few people to report'
	return `${cause}, so this list is shorter than reality. ${tail}`
}

/**
 * The rank line under an exact figure, or nothing.
 *
 * Drawn from the daily series already in the envelope, so it costs no request and — because orders
 * and revenue come from the foundry's own records — inherits none of GA4's loss. Offered only for
 * the EXACT quantities: ranking a GA4 figure would rank the instrument's mood alongside the
 * business.
 *
 * Returns null rather than a hedge when there are too few whole weeks, so a short range simply
 * says less instead of saying something weaker.
 *
 * @param series - the cross-source daily rows
 * @param pick - which exact quantity to rank
 */
export function rankLine(series: CrossSourceDay[] | undefined, pick: (d: CrossSourceDay) => number | null): string | null {
	if (!series || series.length === 0) return null
	const ranked = weeklyRank(series.map((d) => ({ date: d.date, value: pick(d) })))
	return ranked ? describeRank(ranked) : null
}

/**
 * The funnel, split by device, all segments visible at once.
 *
 * This replaced a radiogroup that swapped which funnel was drawn. The single most actionable fact
 * in a foundry's data — at Darden, mobile reaching the second step at a ninth of desktop's rate —
 * was therefore serialised through an interaction: seeing both meant clicking, remembering, and
 * clicking back. A comparison you have to hold in your head is not a comparison the tool made.
 *
 * Each cell carries its DENOMINATOR. The buttons this replaces printed a bare rate to two decimal
 * places with no denominator and no floor, which is the same claim `spread()` refuses below 200
 * users, arriving through the back door with more implied precision than the honest version.
 *
 * A rate is withheld below MIN_RATE_DENOMINATOR, exactly as the funnel itself withholds one. The
 * COUNT is always shown: how many people reached a step is a fact at any sample size, and only the
 * ratio needs protecting.
 */
function SegmentTable({ segments, dimension }: { segments: JourneySegment[]; dimension: string }): React.ReactElement | null {
	if (segments.length < 2) return null

	// Step order comes from the widest segment, so a segment GA4 stopped reporting partway down
	// leaves a gap rather than shortening the table for everyone.
	const spine = [...segments].sort((a, b) => b.steps.length - a.steps.length)[0]?.steps ?? []
	if (spine.length === 0) return null

	return (
		<Stack space={3}>
			<Text size={1} muted>
				Every {dimension} at once. A rate needs {MIN_RATE_DENOMINATOR} people at the step before
				it; below that only the count is shown.
			</Text>
			<Card radius={2} tone="transparent" border style={{ overflowX: 'auto', width: '100%' }}>
				<table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 360 }}>
					<caption style={visuallyHidden}>Funnel steps by {dimension}</caption>
					<thead>
						<tr>
							<th scope="col" style={segmentHeadCell}>Step</th>
							{segments.map((segment) => (
								<th key={segment.key} scope="col" style={{ ...segmentHeadCell, textAlign: 'right' }}>
									{segment.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{spine.map((step, index) => (
							<tr key={step.key}>
								<th scope="row" style={segmentRowCell}>
									<Text size={1}>{step.label}</Text>
								</th>
								{segments.map((segment) => {
									const cell = segment.steps.find((s) => s.key === step.key)
									const count = cell ? metricSortValue(cell.count) : null
									const before = index > 0
										? metricSortValue(segment.steps.find((s) => s.key === spine[index - 1]!.key)?.count)
										: null
									const rate = cell?.conversionFromPrevious ?? null
									// The denominator is the step BEFORE this one, which is what the rate
									// is a share of — and what decides whether it may be stated at all.
									const showRate = index > 0 && rate !== null && before !== null && before >= MIN_RATE_DENOMINATOR

									return (
										<td key={segment.key} style={{ ...segmentRowCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
											{count === null
												? <Text size={1} muted>—</Text>
												: (
													<Stack space={1}>
														<Text size={1}>{formatCount(count)}</Text>
														{showRate && (
															<Text size={0} muted>
																{formatPercent(rate, 1)} of {formatCount(before)}
															</Text>
														)}
													</Stack>
												)}
										</td>
									)
								})}
							</tr>
						))}
					</tbody>
				</table>
			</Card>
		</Stack>
	)
}

export function JourneyPanel({ data }: { data: JourneyData }): React.ReactElement {
	const segments = data.segments ?? []

	// The funnel draws EVERYONE. Per-segment shapes moved into SegmentTable above it, where they
	// can be compared side by side; a funnel that silently became one device's funnel, with only a
	// pressed button to say so, was the thing that made the comparison invisible.
	const allSteps = data.steps ?? []

	// Steps this site does not instrument are hidden rather than drawn as empty rails. An
	// uninstrumented rung told the reader nothing except that the funnel had a hole in it, and it
	// sat between two real steps implying a drop-off that was never measured. They are counted in a
	// line beneath instead, so the omission is still stated but does not masquerade as a stage.
	const shown = allSteps.filter((step) => step.count.status !== 'unavailable')
	const hiddenSteps = allSteps.filter((step) => step.count.status === 'unavailable')

	// The chart takes plain numbers; the unavailable steps have already been removed above, so the
	// narrowing here cannot drop a measured value.
	const stages = shown.flatMap((step) =>
		step.count.status === 'unavailable'
			? []
			: [{ key: step.key, label: step.label, value: step.count.value, conversionFromPrevious: step.conversionFromPrevious }],
	)

	const tracked = data.measurement === 'sequence'

	return (
		<Stack space={4}>
			{/* A tracked funnel is not a caveat, so it is not drawn as one. The fallback still is:
			    independent totals invite exactly the reading — "this many people dropped out here"
			    — that they cannot support. */}
			<Card padding={3} radius={2} tone={tracked ? 'transparent' : 'caution'} border>
				<Stack space={2}>
					<Text size={1} weight="medium">
						{/* "Independent per-step totals" was three words, none of which mean anything to
						    a foundry owner, in the position a heading goes. The distinction it draws is
						    real and load-bearing — it forbids reading the gaps as drop-off — so the
						    wording changes and the claim does not. */}
						{tracked ? 'Tracked path' : 'Not a tracked path'}
					</Text>
					<Text size={1} muted={tracked}>{data.approximationNote}</Text>
				</Stack>
			</Card>

			{/* Every segment at once, instead of a control that swapped between them.
			
			    The radiogroup this replaces put the most actionable fact in the data — mobile
			    reaching the second step at a ninth of desktop's rate — behind clicking, remembering,
			    and clicking back. A comparison the reader has to hold in their head is not a
			    comparison the tool made. Its buttons also printed a bare rate to two decimals with
			    no denominator and no floor: the same claim spread() refuses below 200 users,
			    arriving through the back door with more implied precision. */}
			<SegmentTable segments={segments} dimension={data.segmentDimension ?? 'segment'} />

			{spread(segments) && <Text size={1}>{spread(segments)}</Text>}

			<FunnelChart stages={stages} measurement={data.measurement ?? 'independent-totals'} />

			{/* Side by side on a wide pane. Both blocks are narrow — a few cards and a two-column
			    table — and stacked full width they pushed the funnel a screen and a half up, so the
			    thing the tab is named for scrolled out of view before the supporting evidence
			    started. The grid stacks them again the moment there is not room for both. */}
			<div style={splitGrid}>
			{(data.outcomes?.length ?? 0) > 0 && (
				<Section
					title="Other outcomes"
					/* Beside the funnel, not inside it. An enquiry is an alternative ending, not a
					   later stage — and until now the funnel ended at purchase, which scored the
					   visitor who read three typeface pages and emailed as a drop-off. */
					subtitle="Successful outcomes that are not a licence sale, counted over the same window as the funnel but not a step within it."
				>
					<div style={cardGrid}>
						{(data.outcomes ?? []).map((outcome) => (
							<Card key={outcome.key} padding={3} radius={2} tone="transparent" border>
								<Stack space={3}>
									<Label size={1} muted>{outcome.label}</Label>
									<MetricFigure metric={outcome.count} label={outcome.label} size={4} />
									<Text size={0} muted>{outcome.note}</Text>
								</Stack>
							</Card>
						))}
					</div>
				</Section>
			)}

			{/* Entries, not exits. GA4 exposes landingPage and has never had an exits metric; the
			    previous version of this table queried one and rendered nothing, ever. */}
			{(data.topLandingPages?.length ?? 0) > 0 && (
				<Section title="Where sessions began" subtitle="The page a visit started on, busiest first.">
					<LandingPagesTable rows={data.topLandingPages ?? []} />
				</Section>
			)}
			</div>

			{hiddenSteps.length > 0 && (
				<Text size={1} muted>
					Not shown: {hiddenSteps.map((step) => step.label.toLowerCase()).join(', ')} — not instrumented on
					this site, so there is no figure to place in the funnel.
				</Text>
			)}

		</Stack>
	)
}

/**
 * Landing pages, as a table.
 *
 * Lifted out of `JourneyPanel` so the two supporting blocks on that tab can sit in one grid without
 * a hundred lines of column definitions between them. Behaviour is unchanged.
 *
 * @param rows - landing pages, busiest first
 */
function LandingPagesTable({ rows }: { rows: LandingPage[] }): React.ReactElement {
	return (
		<SortableTable<LandingPage>
						caption="Landing pages by sessions"
						initialSort="sessions"
						rows={rows}
						rowKey={(page) => page.path}
						filterOn={(page) => page.path}
						filterPlaceholder="Filter pages"
						exportName="landing-pages"
						columns={[
							{
								key: 'path',
								label: 'Page',
								sortValue: (page) => page.path,
								// The comment here used to describe this fix without applying it: it said
								// the foundry's own URLs were the one table that did not link while
								// referrer hosts did, and then rendered plain text. A comment asserting
								// something the code does not do is worse than no comment.
								render: (page) => (
									<Text size={1}>
										<a href={page.path} target="_blank" rel="noopener noreferrer" style={sourceLink}>{page.path}</a>
									</Text>
								),
							},
							{
								key: 'sessions',
								label: 'Sessions',
								numeric: true,
								sortValue: (page) => page.sessions,
								render: (page) => <Text size={1}>{formatCount(page.sessions)}</Text>,
							},
							{
								key: 'engagement',
								label: 'Engaged',
								numeric: true,
								sortValue: (page) => finiteOrNull(page.engagementRate),
								exportValue: (page) => { const r = finiteOrNull(page.engagementRate); return r === null ? null : formatPercent(r, 0) },
								// Volume alone could not distinguish a page that delivers 200 arrivals
								// which leave from one that feeds the shop.
								render: (page) => finiteOrNull(page.engagementRate) === null
									? <Text size={1} muted>—</Text>
									: <Text size={1}>{formatPercent(page.engagementRate as number, 0)}</Text>,
							},
						]}
					/>
	)
}

/**
 * The catalogue's own orders-per-view: every family's sales over every family's views.
 *
 * The benchmark was the MEDIAN FAMILY's rate, and that was wrong twice over. It filtered to rates
 * above zero, so a family viewed four hundred times that has never sold — the single most useful
 * row, and the one the column was built to surface — was excluded from the benchmark AND rendered
 * as a dash. And at seven orders a quarter more than half the catalogue sells nothing in a window,
 * so the median is zero and an index against it is undefined for everyone.
 *
 * A pooled rate has neither problem: it is positive whenever anything sold at all, a family with no
 * sales scores an honest zero against it, and it is the benchmark the reader would name themselves
 * — "against how the catalogue as a whole converts".
 *
 * Returns null when nothing sold or nothing was viewed, because there is then no catalogue rate to
 * compare against and an index would be invented.
 *
 * @param rows - every family in the window
 */
/**
 * Views a family needs before its sales-per-view is comparable to anything.
 *
 * Thirty, matching the funnel's floor: below it one more order moves the index by more than a
 * third, so the figure describes a single buyer rather than how the family converts.
 */
const MIN_FAMILY_VIEWS = 30

export function catalogueRate(rows: Array<{ viewed?: MetricValue; bought?: MetricValue }>): number | null {
	let views = 0
	let sales = 0
	for (const row of rows) {
		const viewed = metricSortValue(row.viewed)
		const bought = metricSortValue(row.bought)
		// Both sides or neither: a family GA4 has no view count for cannot contribute its sales to a
		// rate, or the pooled figure would be sales from families whose views are missing.
		if (viewed === null || bought === null) continue
		views += viewed
		sales += bought
	}
	return views > 0 && sales > 0 ? sales / views : null
}

/**
 * A family's orders-per-view against the catalogue's, or null when not comparable.
 *
 * Zero is a RESULT, not an absence: a family that was viewed and never bought scores 0 and belongs
 * at the bottom of the sort, which is where a reader looking for a pricing or specimen problem
 * starts. Only a family with no usable rate at all returns null.
 *
 * @param row - the family's row
 * @param benchmark - the catalogue rate, or null when there was none
 */
export function buyRateIndex(
	row: { buyRate?: number | null; viewed?: MetricValue },
	benchmark: number | null,
): number | null {
	const rate = row.buyRate
	if (benchmark === null || benchmark <= 0) return null
	if (rate === null || rate === undefined || !Number.isFinite(rate) || rate < 0) return null

	/*
	 * The family's own views have to carry a ratio, not just the catalogue's.
	 *
	 * Every other small-sample figure here is gated by a number — the funnel withholds a rate below
	 * thirty and says "too few to give a rate", the revenue split needs five attributed purchases and
	 * a quarter of the order book. This column was gated only by a sentence in the blurb. On a
	 * catalogue where a family's month is sixteen views and zero-or-one order, a single sale printed
	 * "4.9× catalogue" in the same type as a figure computed on hundreds, and a reader would put that
	 * typeface on the homepage on the strength of one order.
	 *
	 * The same floor the funnel uses, applied to the denominator that actually varies per row.
	 */
	const views = metricSortValue(row.viewed)
	if (views === null || views < MIN_FAMILY_VIEWS) return null

	return rate / benchmark
}

/**
 * Revenue divided by the orders that actually carried an amount.
 *
 * NOT by the full order count. At Darden 58 of 69 counted orders have no amount recorded, so
 * dividing the revenue sum by every order would report an average six times too low — a number
 * someone might price against. The denominator has to be the same population as the numerator.
 *
 * Inherits `partial` from the revenue figure, because an average over a sixth of the orders is an
 * average of that sixth and should not present as the catalogue's.
 *
 * @param data - the overview payload
 */
/**
 * What a campaign's following days took, per thousand addresses it went to.
 *
 * Per thousand rather than per send because a foundry mails thousands against a handful of orders:
 * divided per send the figure is fractions of a cent and every campaign renders as the same zero.
 *
 * Null — never zero — when there is no revenue figure, no send count, or the window has not run,
 * so an unmeasured campaign is not ranked below one that genuinely sold nothing.
 *
 * @param campaign - one send, already carrying its following-days figures
 */
export function revenuePerThousandSent(campaign: EmailCampaign): number | null {
	if (campaign.revenueAfter === null || campaign.revenueAfter === undefined) return null
	if (!Number.isFinite(campaign.sent) || campaign.sent <= 0) return null
	return (campaign.revenueAfter / campaign.sent) * 1000
}

export function averageOrderValue(data: MeasurementHealthData): MetricValue {
	/*
	 * A derived figure INHERITS the absence of what it was derived from.
	 *
	 * Both of these first returned `not_applicable` for any missing input — which on a site whose
	 * route predates the fields renders "Does not apply to this site" over a dash, the precise
	 * contradiction removed from `metricOr` two releases ago, reintroduced one layer up. The
	 * version-skew test caught it, which is what that test is for. `metricOr` already knows how to
	 * describe a field the route is too old to send; a derived figure should say the same thing.
	 */
	const revenueMetric = metricOr(data.revenue, OLDER_ROUTE)
	if (revenueMetric.status === 'unavailable') return revenueMetric
	const revenue = metricSortValue(revenueMetric)
	const orders = finiteOrNull(data.ordersWithTotal)
	if (revenue === null || orders === null || orders <= 0) {
		return unavailable('not_applicable', 'No order in this range carried an amount to average')
	}
	const average = revenue / orders
	// Partial is decided here rather than inherited from the revenue metric, because this figure has
	// its own denominator: whenever fewer orders carry an amount than were counted, the average is
	// over a subset and the reader has to be told which subset before comparing it to anything.
	const counted = finiteOrNull(metricSortValue(metricOr(data.orders, OLDER_ROUTE)))
	const overSubset = counted !== null && counted > orders
	return overSubset || data.revenue.status === 'partial'
		? partial(average, '', `Averaged over the ${formatCount(orders)} of ${formatCount(counted ?? orders)} orders that carry an amount.`)
		: ok(average)
}

/**
 * How many visitors it takes to make one sale.
 *
 * Against VERCEL's visitors rather than GA4's sessions. The owner's instinct is orders-per-session,
 * but GA4 sees a fraction of the traffic here, so that ratio would flatter conversion by whatever
 * share is missing — the same mistake the buy-rate column was rebuilt to avoid. Vercel is the least
 * lossy denominator available, and it counts people rather than visits, which is the unit a sale
 * belongs to.
 *
 * @param data - the overview payload
 */
export function visitorsPerOrder(data: MeasurementHealthData): MetricValue {
	const visitorMetric = metricOr(data.vercelVisitors, OLDER_ROUTE)
	const orderMetric = metricOr(data.orders, OLDER_ROUTE)
	if (visitorMetric.status === 'unavailable') return visitorMetric
	if (orderMetric.status === 'unavailable') return orderMetric
	const visitors = metricSortValue(visitorMetric)
	const orders = metricSortValue(orderMetric)
	if (visitors === null || orders === null || orders <= 0) {
		return unavailable('not_applicable', 'No order in this range to divide the visitors by')
	}
	return ok(Math.round(visitors / orders))
}

/** Typeface interest — viewed, tested and bought per family. */
export function TypefaceInterestPanel({ data }: { data: TypefaceInterestData }): React.ReactElement {
	// The whole catalogue's orders-per-view, which every family is measured against.
	const benchmark = catalogueRate(data.rows ?? [])

	return (
		<Stack space={4}>
			<Card padding={3} radius={2} tone="transparent" border>
				<Text size={1} muted>{data.interpretationNote}</Text>
			</Card>

			<Stack space={3}>
				<SectionTitle title="Engagement by typeface" />
				<Text size={1} muted>
					Sort by any column. &ldquo;Sells vs catalogue&rdquo; compares each family&rsquo;s sales-per-view
					against the catalogue as a whole — 1.0× is average, and sorting up finds the families that
					are looked at and do not sell. It is a comparison between your families, not the share of
					visitors who buy: Google Analytics sees only a fraction of the views, which moves every
					family together and so cancels out here. With one or two sales a family will still swing a
					long way, so read it alongside the order counts beside it.
					{' '}Bought and Revenue come from your own orders and are exact — do not scale those up.
					{' '}A family needs a reasonable number of views before it gets a comparison at all;
					below that it says so rather than ranking one order against the catalogue.
				</Text>
				<SortableTable<TypefaceInterestRow>
					caption="Engagement by typeface"
					initialSort="viewed"
					rows={data.rows ?? []}
					rowKey={(row) => row.typeface}
					filterOn={(row) => row.typeface}
					filterPlaceholder="Filter typefaces"
					exportName="typeface-interest"
					truncatedNote={shortListNote(
						Boolean(data.rowsTruncated),
						Boolean(data.rowsWithheld),
						'A family missing from this table has not necessarily gone quiet — and for a foundry the long tail is most of the catalogue.',
					)}
					columns={[
						{
							key: 'typeface',
							label: 'Typeface',
							sortValue: (row) => row.typeface,
							render: (row) => <Text size={1}>{row.typeface}</Text>,
						},
						{
							key: 'viewed',
							// The source is in the HEADER, because the ribbon at the top of this tab
							// instructs the reader to multiply its figures by about five — and two of
							// these four columns come from the order book and are exact. Following that
							// instruction across the whole table multiplies real revenue fivefold. The
							// sentence that prevents it already exists on the licence block below; it was
							// simply never applied where the mistake is made.
							label: 'Viewed (GA4)',
							numeric: true,
							sortValue: (row) => metricSortValue(row.viewed),
							render: (row) => <MetricFigure metric={row.viewed} label={`${row.typeface} viewed`} size={1} />,
						},
						{
							key: 'tested',
							label: 'Tested (GA4)',
							numeric: true,
							sortValue: (row) => metricSortValue(row.tested),
							render: (row) => <MetricFigure metric={row.tested} label={`${row.typeface} tested`} size={1} />,
						},
						{
							key: 'bought',
							label: 'Bought (orders)',
							numeric: true,
							sortValue: (row) => metricSortValue(row.bought),
							render: (row) => <MetricFigure metric={row.bought} label={`${row.typeface} bought`} size={1} />,
						},
						{
							key: 'revenue',
							label: 'Revenue (orders)',
							numeric: true,
							sortValue: (row) => metricSortValue(row.revenue),
							exportValue: (row) => {
								const value = metricSortValue(row.revenue)
								return value === null ? null : formatMoney(value, data.currency ?? null)
							},
							// The column that lets a catalogue be ranked by what it is worth rather
							// than by unit count, where a $30 web licence and a $400 desktop family
							// were the same integer.
							// Only a plain `ok` takes the bare-text branch. A `partial` value kept its
							// number but lost the caution badge and the note explaining what it
							// covers, which every other numeric column in this table keeps.
							render: (row) => {
								const revenue = metricOr(row.revenue, OLDER_ROUTE)
								return revenue.status === 'ok'
									? <Text size={1}>{formatMoney(revenue.value, data.currency ?? null)}</Text>
									: <MetricFigure metric={revenue} label={`${row.typeface} revenue`} size={1} />
							},
						},
						{
							/*
							 * Relative to the catalogue, NOT an absolute rate.
							 *
							 * This is Sanity orders over GA4 views: a complete numerator on a lossy
							 * denominator. Printed as "0.85%" it invited the reading "eight in a
							 * thousand visitors buy this", which is wrong by whatever multiple GA4 is
							 * missing — and it MOVES when the tag breaks. When Darden's GA4 count fell
							 * from 471 a day to 70, every family's printed rate multiplied by about
							 * seven, and the families that looked best were the ones GA4 had stopped
							 * seeing.
							 *
							 * What survives that is the ORDER. The loss is roughly uniform across
							 * families, so it cancels in a comparison between them even as it wrecks
							 * the absolute figure. Showing each family against the catalogue median
							 * keeps the one question this column can answer — which families convert
							 * better or worse than the rest — and drops the one it cannot.
							 */
							key: 'buyRate',
							label: 'Sells vs catalogue',
							numeric: true,
							// The INDEX, so a row rendered as a dash cannot sort above a row with a value.
							// Sorting on the raw rate returned 0 — a real number — for a family whose
							// cell showed "—", so ascending put a block of dashes at the top of the
							// table, which is the one thing this file's header forbids.
							sortValue: (row) => buyRateIndex(row, benchmark),
							exportValue: (row) => {
								const index = buyRateIndex(row, benchmark)
								return index === null ? null : `${index.toFixed(1)}x catalogue`
							},
							render: (row) => {
								const index = buyRateIndex(row, benchmark)
								if (index === null) {
									// Says which absence it is, like the funnel does. A dash alone made a
									// family too quiet to compare look the same as one the catalogue could
									// not be benchmarked against at all.
									const views = metricSortValue(row.viewed)
									const tooQuiet = views !== null && views < MIN_FAMILY_VIEWS
									return (
										<Text size={1} muted aria-label={`${row.typeface} not comparable`}>
											{tooQuiet ? 'too few views to compare' : '—'}
										</Text>
									)
								}
								if (index === 0) {
									// Named, not left as "0.0×". A family with views and no sales is the
									// row this column exists to surface.
									return <Text size={1}>No sales</Text>
								}
								return (
									<Text size={1}>
										{index.toFixed(1)}× catalogue
									</Text>
								)
							},
						},
						// No Test rate column. It was tested ÷ viewed, rendered muted, from the two
						// columns immediately to its left — and typefaceInterest's own note says that
						// where a site maps several tester events onto the step (TDF names three) the
						// numerator is not a person count, so the ratio ranks page layout as much as
						// interest. A reader who wants it can see both terms side by side.
					]}
				/>
			</Stack>

			{(data.licences?.length ?? 0) > 0 && (
				<Stack space={3}>
					<SectionTitle title="How licences sell" />
					<Text size={1} muted>
						From your orders, so exact.
						Tier and term are separate rows, because they are the two variables in the pricing
						question and a tier that sells well at one year may not at perpetual.
					</Text>
					<ProportionChart
						bars={(data.licences ?? []).map((row) => ({
							key: `${row.type}-${row.tier}-${row.term}`,
							label: `${row.type} · ${row.tier}`,
							sublabel: row.term,
							// Ranked by revenue where it is known, by orders where it is not — a
							// count would put a cheap tier above one worth ten times as much.
							value: row.revenue ?? row.orders,
						}))}
						format={(value) => (data.licences ?? []).some((r) => r.revenue !== null)
							? formatMoney(value, data.currency ?? null)
							: `${formatCount(value)} orders`}
						totalLabel={(data.licences ?? []).some((r) => r.revenue !== null) ? 'Total across licences' : 'Total licence lines'}
					/>

				</Stack>
			)}

			{/* Both completeness flags were computed by the server and drawn nowhere, so a table
			    holding part of the catalogue was presented as the catalogue. */}

			{/* One apportionment note for the panel, not one per section. The licence table and the
			    family table were each printing a near-identical sentence about even splitting,
			    ~28 words apart, which read as a stutter and made the other notes look cheaper. */}
			{data.revenueIsApportioned && (
				<Text size={0} muted>
					Revenue is apportioned: an order covering several families or licences is split evenly
					between them, because the order documents carry no per-line value.
				</Text>
			)}
		</Stack>
	)
}

/** Sanity UI tone for each check status. Status is also always spelled out in text. */
const CHECK_TONE: Record<CheckStatus, 'positive' | 'caution' | 'critical' | 'default'> = {
	pass: 'positive',
	warn: 'caution',
	fail: 'critical',
	skipped: 'default',
}

/** Word shown alongside the tone, so status never depends on colour alone. */
const CHECK_WORD: Record<CheckStatus, string> = {
	pass: 'Pass',
	warn: 'Check',
	fail: 'Fail',
	skipped: 'Skipped',
}

/**
 * Diagnostics — what to fix before trusting anything else here.
 *
 * Deliberately the panel that still works with nothing configured: on a site without credentials
 * it is the only one that can say something useful, and it is the first thing worth opening once
 * credentials land.
 */
export function DiagnosticsPanel({ data }: { data: DiagnosticReport }): React.ReactElement {
	// Guarded like every other array the panels read. This one was missed in the pass that made
	// the rest skew-tolerant, and it is what crashed the Diagnostics tab: `checks` is absent from
	// an older route's response, and `undefined.filter` takes the whole tool down.
	const checks = data.checks ?? []
	const failing = checks.filter((c) => c.status === 'fail').length
	const warning = checks.filter((c) => c.status === 'warn').length

	// Scoped to what these checks actually test. The previous wording — "the figures in the other
	// panels can be taken at face value" — was a blanket endorsement covering statistical validity,
	// sampling, small denominators and a funnel the tool itself calls an approximation. These are
	// plumbing checks. A pass means the wiring is sound, not that the numbers are.
	const summary =
		checks.length === 0
			? 'No checks ran. Nothing here has been verified either way.'
			: data.verdict === 'pass'
				? 'Configuration and credentials check out. That covers the wiring, not whether the figures are worth trusting — the caveats on each panel still apply.'
				// A verdict of `skipped` is not a failure. The server-side severity order was fixed
				// so an all-skipped run stops reporting as a problem, but this branch still fell
				// through to the failure sentence and printed "0 failing, 0 worth a look. Panels
				// depending on these will be wrong or incomplete" — alarming, and false. Checks skip
				// routinely: no Vercel project, no purchases in the window, no orders in thirty days.
				: failing === 0 && warning === 0
					? `Nothing is failing. ${checks.length - failing - warning} check${checks.length - failing - warning === 1 ? '' : 's'} could not run in this range — usually because there was nothing to check, not because something is wrong.`
					: `${failing} failing, ${warning} worth a look. Panels depending on these will be wrong or incomplete until they are resolved.`

	return (
		<Stack space={4}>
			<Card padding={3} radius={2} tone={CHECK_TONE[data.verdict] ?? 'default'} border>
				<Text size={1}>{summary}</Text>
			</Card>

			<Stack space={3}>
				{checks.map((item) => (
					<Card key={item.id} padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Flex align="center" justify="space-between" gap={3}>
								<Text size={1} weight="semibold">{item.label}</Text>
								<Badge tone={CHECK_TONE[item.status] ?? 'default'} fontSize={0}>{CHECK_WORD[item.status] ?? item.status}</Badge>
							</Flex>
							<Text size={1} muted>{item.detail}</Text>
							{item.remedy && <Text size={1}>{item.remedy}</Text>}
						</Stack>
					</Card>
				))}
			</Stack>
		</Stack>
	)
}
