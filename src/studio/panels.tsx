/**
 * The four report panels.
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
import { Badge, Box, Card, Flex, Grid, Heading, Label, Stack, Text } from '@liiift-studio/sanity-ui-compat'
import { ComparisonBar, Delta, FunnelChart, MetricFigure, NoticeList, SortableTable, TrendChart, formatCount, formatMoney, formatPercent } from './Figure'
import type {
	AcquisitionData,
	CheckStatus,
	SourceRow,
	TypefaceInterestRow,
	DiagnosticReport,
	JourneyData,
	LandingPage,
	MeasurementHealthData,
	TypefaceInterestData,
} from '../reportData'
import type { MetricValue } from '../types'

/**
 * Sortable value for a metric, or null when there is nothing to sort on.
 *
 * An unavailable metric is not a zero — sorting it as one would put "never measured" at the bottom
 * of an ascending column beside genuine zeros, which is the confusion MetricValue exists to prevent.
 * SortableTable sinks nulls in both directions instead.
 */
function metricSortValue(metric: MetricValue): number | null {
	return metric.status === 'unavailable' ? null : metric.value
}

/** Largest available value across metrics, for scaling bars. */
function maxOf(metrics: MetricValue[]): number {
	return metrics.reduce((max, metric) => (metric.status === 'unavailable' ? max : Math.max(max, metric.value)), 0)
}

/** Shared table styling — scrolls inside its own container so the panel never scrolls sideways. */
const tableWrap: React.CSSProperties = { overflowX: 'auto', width: '100%' }

/**
 * Section headings.
 *
 * The UI kit's Heading carries no margin of its own and relies on Stack spacing, which the compat
 * shim drops when it falls back — so headings sat directly on the section above and read as part
 * of it. An explicit top margin and a little breathing room below make each section legible as a
 * section regardless of what the shim resolves.
 */
const sectionHeading: React.CSSProperties = { margin: '0 0 2px', lineHeight: 1.3 }

/** A figure with its period-over-period delta alongside, wrapping on a narrow pane. */
const figureRow: React.CSSProperties = {
	display: 'flex',
	alignItems: 'baseline',
	gap: 10,
	flexWrap: 'wrap',
}

/** Referrer links, marked as links without shouting. */
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
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', minWidth: 420 }
const cell: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--card-border-color)' }
// @sanity/ui ships no Table primitive, so the element is native — but every cell's content is a
// Sanity UI component, and the table sits inside a Card, so it themes with the rest of the Studio.
const numericCell: React.CSSProperties = { ...cell, textAlign: 'right' }

/**
 * Measurement Health — how much of reality each source sees.
 * Compares pageviews to pageviews. Sessions and orders sit alongside as context and are never
 * subtracted from a pageview count.
 */
export function MeasurementHealthPanel({ data }: { data: MeasurementHealthData }): React.ReactElement {
	const pageviewMax = maxOf([data.ga4Pageviews, data.vercelPageviews])

	return (
		<Stack space={4}>
			<Stack space={3}>
				<Heading size={1} style={sectionHeading}>Pageviews, source against source</Heading>
				<Text size={1} muted>
					The same unit on both sides. Vercel is cookieless and ungated; GA4 is consent-gated and
					blockable, so GA4 seeing fewer is expected.
				</Text>
				<ComparisonBar label="Vercel pageviews" metric={data.vercelPageviews} max={pageviewMax} tone="primary" />
				<ComparisonBar label="GA4 pageviews" metric={data.ga4Pageviews} max={pageviewMax} tone="default" />
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

			{/* The daily series. A scalar gap cannot tell a stable difference from one that opened
			    overnight, and those need opposite responses. Rendered only when there are enough
			    points to show a shape, and only when both sources reported by day. */}
			{(data.daily?.length ?? 0) >= 3 && (
				<Stack space={3}>
					<Heading size={1} style={sectionHeading}>Day by day</Heading>
					<Text size={1} muted>
						A gap that has always been there is consent and blocking. A gap that opens on one
						day is an incident.
					</Text>
					<TrendChart points={data.daily ?? []} />
					{/* The whole chart used to disappear here rather than lose one line — at exactly
					    the 90-day range where someone would look for when a gap opened, which is the
					    reason this chart exists. GA4's series is daily at every range, so it stays. */}
					{data.vercelDailyUnavailable && (
						<Text size={0} muted>
							Vercel reports this range in weekly buckets, so only the GA4 line is plotted.
							Choose Week or Month to see both.
						</Text>
					)}
				</Stack>
			)}

			<Stack space={3}>
				<Heading size={1} style={sectionHeading}>Context</Heading>
				<Text size={1} muted>
					Different units to the figures above, and to each other. Shown for scale, never differenced.
				</Text>
				<div style={cardGrid}>
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>Vercel visitors</Label>
							{/* Fetched on every call and previously discarded, though it is the only
							    visitor figure here that consent refusal and ad-blocking cannot reduce. */}
							<MetricFigure metric={data.vercelVisitors} label="Vercel visitors" />
							<Text size={0} muted>Counted server-side, so neither consent nor ad-blocking reduces it.</Text>
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
							<Label size={1} muted>Orders</Label>
							<MetricFigure metric={data.orders} label="Orders" />
						</Stack>
					</Card>
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>Consent granted</Label>
							<MetricFigure metric={data.consentRate} label="Consent granted, percent of sessions" unit="percent" />
						</Stack>
					</Card>
				</div>
			</Stack>
		</Stack>
	)
}

/** Acquisition — where visitors came from, with design-industry referrers called out. */
export function AcquisitionPanel({ data, previous }: { data: AcquisitionData; previous?: AcquisitionData }): React.ReactElement {
	return (
		<Stack space={4}>
			<div style={cardGrid}>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Sessions</Label>
						<div style={figureRow}>
							<Text size={4}>{formatCount(data.totalSessions)}</Text>
							<Delta current={data.totalSessions} previous={previous?.totalSessions ?? null} />
						</div>
					</Stack>
				</Card>
				{data.designIndustryShare !== null && (
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>From design-industry referrers</Label>
							<div style={figureRow}>
								<Text size={4}>{formatPercent(data.designIndustryShare, 1)}</Text>
								<Delta
									current={data.designIndustryShare * 100}
									previous={previous?.designIndustryShare != null ? previous.designIndustryShare * 100 : null}
									unit="percent"
								/>
							</div>
							{/* Named as list-dependent. Printed bare, this figure was read as a verdict
							    on the design press when it reports the coverage of a short list. */}
							<Text size={0} muted>Share of sessions from a known design-press referrer.</Text>
						</Stack>
					</Card>
				)}
				{data.unattributedShare !== null && (
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>Unattributed</Label>
							<div style={figureRow}>
								<Text size={4}>{formatPercent(data.unattributedShare, 1)}</Text>
								<Delta
									current={data.unattributedShare * 100}
									previous={previous?.unattributedShare != null ? previous.unattributedShare * 100 : null}
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
				<Heading size={1} style={sectionHeading}>Traffic sources</Heading>
				<Text size={1} muted>Sort, filter, or exclude a row to see what the rest looks like.</Text>
				<SortableTable<SourceRow>
					caption="Traffic sources by sessions"
					initialSort="sessions"
					rows={data.rows ?? []}
					rowKey={(row) => `${row.source}-${row.channel}`}
					filterOn={(row) => `${row.source} ${row.channel} ${row.medium ?? ''} ${row.campaign ?? ''}`}
					filterPlaceholder="Filter sources"
					exportName="traffic-sources"
					truncatedNote={data.rowsTruncated
						? 'GA4 held more source rows than are shown here, so this is the top of a longer list — for a foundry, the tail of small design blogs is often the referral story.'
						: undefined}
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
										: <Text size={1}>{row.source}</Text>}
									{row.designIndustry && <Badge tone="primary" fontSize={0}>Design</Badge>}
									{row.unattributed && <Badge tone="caution" fontSize={0}>Unattributed</Badge>}
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
							sortValue: (row) => row.engagementRate,
							// The quality signal. Ranked by volume alone, 27 Display sessions looked
							// equal to 27 from Search, which flatters the worst line of spend.
							render: (row) => row.engagementRate === null
								? <Text size={1} muted>—</Text>
								: <Text size={1}>{formatPercent(row.engagementRate, 0)}</Text>,
						},
					]}
				/>
			</Stack>

			{data.rowsWithheld && (
				<NoticeList notices={['GA4 withheld some low-traffic rows for privacy, so this list is shorter than reality.']} />
			)}
		</Stack>
	)
}

/** Journey — a funnel, drawn as a tracked sequence or as independent totals, whichever the report used. */
export function JourneyPanel({ data }: { data: JourneyData }): React.ReactElement {
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
						{tracked ? 'Tracked funnel' : 'Independent per-step totals'}
					</Text>
					<Text size={1} muted={tracked}>{data.approximationNote}</Text>
				</Stack>
			</Card>

			<FunnelChart stages={stages} measurement={data.measurement ?? 'independent-totals'} />

			{(data.outcomes?.length ?? 0) > 0 && (
				<Stack space={3}>
					<Heading size={1} style={sectionHeading}>Other outcomes</Heading>
					{/* Beside the funnel, not inside it. An enquiry is an alternative ending, not a
					    later stage — and until now the funnel ended at purchase, which scored the
					    visitor who read three typeface pages and emailed as a drop-off. */}
					<Text size={1} muted>
						Successful outcomes that are not a licence sale. Counted over the same window as the
						funnel, but not a step within it.
					</Text>
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
				</Stack>
			)}

			{hiddenSteps.length > 0 && (
				<Text size={1} muted>
					Not shown: {hiddenSteps.map((step) => step.label.toLowerCase()).join(', ')} — not instrumented on
					this site, so there is no figure to place in the funnel.
				</Text>
			)}

			{/* Entries, not exits. GA4 exposes landingPage and has never had an exits metric; the
			    previous version of this table queried one and rendered nothing, ever. */}
			{(data.topLandingPages?.length ?? 0) > 0 && (
				<Stack space={3}>
					<Heading size={1} style={sectionHeading}>Where sessions began</Heading>
					<SortableTable<LandingPage>
						caption="Landing pages by sessions"
						initialSort="sessions"
						rows={data.topLandingPages ?? []}
						rowKey={(page) => page.path}
						filterOn={(page) => page.path}
						filterPlaceholder="Filter pages"
						exportName="landing-pages"
						columns={[
							{
								key: 'path',
								label: 'Page',
								sortValue: (page) => page.path,
								// The foundry's own URLs were the one table that did not link, while
								// referrer hosts did — so clicking took you to somebody else's site
								// and the pages you might want to open would not open.
								render: (page) => <Text size={1}>{page.path}</Text>,
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
								sortValue: (page) => page.engagementRate,
								// Volume alone could not distinguish a page that delivers 200 arrivals
								// which leave from one that feeds the shop.
								render: (page) => page.engagementRate === null
									? <Text size={1} muted>—</Text>
									: <Text size={1}>{formatPercent(page.engagementRate, 0)}</Text>,
							},
						]}
					/>
				</Stack>
			)}
		</Stack>
	)
}

/** Typeface interest — viewed, tested and bought per family. */
export function TypefaceInterestPanel({ data }: { data: TypefaceInterestData }): React.ReactElement {
	return (
		<Stack space={4}>
			<Card padding={3} radius={2} tone="transparent" border>
				<Text size={1} muted>{data.interpretationNote}</Text>
			</Card>

			<Stack space={3}>
				<Heading size={1} style={sectionHeading}>Engagement by typeface</Heading>
				<Text size={1} muted>
					Sort by any column. Sort on buy rate to find families that are looked at and do not sell.
				</Text>
				<SortableTable<TypefaceInterestRow>
					caption="Engagement by typeface"
					initialSort="viewed"
					rows={data.rows ?? []}
					rowKey={(row) => row.typeface}
					filterOn={(row) => row.typeface}
					filterPlaceholder="Filter typefaces"
					exportName="typeface-interest"
					truncatedNote={data.rowsTruncated
						? 'GA4 returned only its top rows, so families past the cap show as unknown rather than as zero. For a foundry the long tail is most of the catalogue.'
						: undefined}
					columns={[
						{
							key: 'typeface',
							label: 'Typeface',
							sortValue: (row) => row.typeface,
							render: (row) => <Text size={1}>{row.typeface}</Text>,
						},
						{
							key: 'viewed',
							label: 'Viewed',
							numeric: true,
							sortValue: (row) => metricSortValue(row.viewed),
							render: (row) => <MetricFigure metric={row.viewed} label={`${row.typeface} viewed`} size={1} />,
						},
						{
							key: 'tested',
							label: 'Tested',
							numeric: true,
							sortValue: (row) => metricSortValue(row.tested),
							render: (row) => <MetricFigure metric={row.tested} label={`${row.typeface} tested`} size={1} />,
						},
						{
							key: 'bought',
							label: 'Bought',
							numeric: true,
							sortValue: (row) => metricSortValue(row.bought),
							render: (row) => <MetricFigure metric={row.bought} label={`${row.typeface} bought`} size={1} />,
						},
						{
							key: 'revenue',
							label: 'Revenue',
							numeric: true,
							sortValue: (row) => metricSortValue(row.revenue),
							// The column that lets a catalogue be ranked by what it is worth rather
							// than by unit count, where a $30 web licence and a $400 desktop family
							// were the same integer.
							render: (row) => row.revenue.status === 'unavailable'
								? <MetricFigure metric={row.revenue} label={`${row.typeface} revenue`} size={1} />
								: <Text size={1}>{formatMoney(row.revenue.value, data.currency)}</Text>,
						},
						{
							key: 'buyRate',
							label: 'Buy rate',
							numeric: true,
							sortValue: (row) => row.buyRate,
							render: (row) => (
								<Text size={1} muted aria-label={row.buyRate === null ? `${row.typeface} buy rate unavailable` : undefined}>
									{row.buyRate === null ? '—' : formatPercent(row.buyRate, 2)}
								</Text>
							),
						},
						{
							key: 'testRate',
							label: 'Test rate',
							numeric: true,
							sortValue: (row) => row.testRate,
							render: (row) => (
								<Text size={1} muted aria-label={row.testRate === null ? `${row.typeface} test rate unavailable` : undefined}>
									{row.testRate === null ? '—' : formatPercent(row.testRate, 1)}
								</Text>
							),
						},
					]}
				/>
			</Stack>

			{/* Both completeness flags were computed by the server and drawn nowhere, so a table
			    holding part of the catalogue was presented as the catalogue. */}
			{data.rowsWithheld && (
				<NoticeList notices={['GA4 withheld some low-count rows for privacy. A family missing from this table has not necessarily gone quiet.']} />
			)}

			{data.revenueIsApportioned && (
				<Text size={0} muted>
					Revenue is apportioned: an order covering several families is split evenly between them,
					because the order documents carry no per-family line value.
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
