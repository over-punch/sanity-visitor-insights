/**
 * The four report panels.
 *
 * Every panel renders a table or labelled bars rather than a chart, and every one surfaces its own
 * caveats inline. Tables are the accessible representation as well as the visual one, so there is
 * no separate "view as data" toggle that could drift out of sync with what is displayed.
 */

import React from 'react'
import { Badge, Box, Card, Flex, Grid, Heading, Label, Stack, Text } from '@liiift-studio/sanity-ui-compat'
import { ComparisonBar, MetricFigure, NoticeList, TrendChart, formatCount, formatPercent } from './Figure'
import type {
	AcquisitionData,
	CheckStatus,
	DiagnosticReport,
	JourneyData,
	MeasurementHealthData,
	TypefaceInterestData,
} from '../reportData'
import type { MetricValue } from '../types'

/** Largest available value across metrics, for scaling bars. */
function maxOf(metrics: MetricValue[]): number {
	return metrics.reduce((max, metric) => (metric.status === 'unavailable' ? max : Math.max(max, metric.value)), 0)
}

/** Shared table styling — scrolls inside its own container so the panel never scrolls sideways. */
const tableWrap: React.CSSProperties = { overflowX: 'auto', width: '100%' }
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
				<Heading size={1}>Pageviews, source against source</Heading>
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
			{data.daily.length >= 3 && (
				<Stack space={3}>
					<Heading size={1}>Day by day</Heading>
					<Text size={1} muted>
						A gap that has always been there is consent and blocking. A gap that opens on one
						day is an incident.
					</Text>
					<TrendChart points={data.daily} />
				</Stack>
			)}

			<Stack space={3}>
				<Heading size={1}>Context</Heading>
				<Text size={1} muted>
					Different units to the figures above, and to each other. Shown for scale, never differenced.
				</Text>
				<Grid columns={[1, 3]} gap={4}>
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
				</Grid>
			</Stack>
		</Stack>
	)
}

/** Acquisition — where visitors came from, with design-industry referrers called out. */
export function AcquisitionPanel({ data }: { data: AcquisitionData }): React.ReactElement {
	return (
		<Stack space={4}>
			<Grid columns={[1, 3]} gap={4}>
				<Card padding={3} radius={2} tone="transparent" border>
					<Stack space={3}>
						<Label size={1} muted>Sessions</Label>
						<Text size={4}>{formatCount(data.totalSessions)}</Text>
					</Stack>
				</Card>
				{data.designIndustryShare !== null && (
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>From design-industry referrers</Label>
							<Text size={4}>{formatPercent(data.designIndustryShare, 1)}</Text>
						</Stack>
					</Card>
				)}
				{data.unattributedShare !== null && (
					<Card padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Label size={1} muted>Unattributed</Label>
							<Text size={4}>{formatPercent(data.unattributedShare, 1)}</Text>
						</Stack>
					</Card>
				)}
			</Grid>

			<Card radius={2} tone="transparent" border style={tableWrap}>
				<table style={table}>
					<caption style={{ textAlign: 'left', paddingBottom: 8 }}>
						<Text size={1} muted>Traffic sources by sessions</Text>
					</caption>
					<thead>
						<tr>
							<th scope="col" style={cell}><Label size={1} muted>Source</Label></th>
							<th scope="col" style={cell}><Label size={1} muted>Channel</Label></th>
							<th scope="col" style={numericCell}><Label size={1} muted>Sessions</Label></th>
						</tr>
					</thead>
					<tbody>
						{data.rows.map((row) => (
							<tr key={`${row.source}-${row.channel}`}>
								<th scope="row" style={cell}>
									<Flex gap={2} align="center">
										<Text size={1}>{row.source}</Text>
										{row.designIndustry && <Badge tone="primary" fontSize={0}>design industry</Badge>}
										{row.unattributed && <Badge tone="caution" fontSize={0}>unattributed</Badge>}
									</Flex>
								</th>
								<td style={cell}><Text size={1} muted>{row.channel}</Text></td>
								<td style={numericCell}><Text size={1}>{formatCount(row.sessions)}</Text></td>
							</tr>
						))}
					</tbody>
				</table>
			</Card>

			{data.rowsWithheld && (
				<NoticeList notices={['GA4 withheld some low-traffic rows for privacy, so this list is shorter than reality.']} />
			)}
		</Stack>
	)
}

/** Journey — per-step totals with adjacent drop-off, explicitly not a tracked path. */
export function JourneyPanel({ data }: { data: JourneyData }): React.ReactElement {
	const max = maxOf(data.steps.map((step) => step.count))

	return (
		<Stack space={4}>
			<Card padding={3} radius={2} tone="caution" border>
				<Text size={1}>{data.approximationNote}</Text>
			</Card>

			<Stack space={3}>
				{data.steps.map((step) => (
					<Stack space={2} key={step.key}>
						<ComparisonBar label={step.label} metric={step.count} max={max} tone="primary" />
						{step.conversionFromPrevious !== null && (
							<Text size={0} muted>{formatPercent(step.conversionFromPrevious, 1)} of the previous measurable step</Text>
						)}
					</Stack>
				))}
			</Stack>

			{data.topExitPages.length > 0 && (
				<Stack space={3}>
					<Heading size={1}>Where sessions ended</Heading>
					<Card radius={2} tone="transparent" border style={tableWrap}>
						<table style={table}>
							<thead>
								<tr>
									<th scope="col" style={cell}><Label size={1} muted>Page</Label></th>
									<th scope="col" style={numericCell}><Label size={1} muted>Exits</Label></th>
								</tr>
							</thead>
							<tbody>
								{data.topExitPages.map((page) => (
									<tr key={page.path}>
										<th scope="row" style={cell}><Text size={1}>{page.path}</Text></th>
										<td style={numericCell}><Text size={1}>{formatCount(page.exits)}</Text></td>
									</tr>
								))}
							</tbody>
						</table>
					</Card>
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

			<Card radius={2} tone="transparent" border style={tableWrap}>
				<table style={table}>
					<caption style={{ textAlign: 'left', paddingBottom: 8 }}>
						<Text size={1} muted>Engagement by typeface</Text>
					</caption>
					<thead>
						<tr>
							<th scope="col" style={cell}><Label size={1} muted>Typeface</Label></th>
							<th scope="col" style={numericCell}><Label size={1} muted>Viewed</Label></th>
							<th scope="col" style={numericCell}><Label size={1} muted>Tested</Label></th>
							<th scope="col" style={numericCell}><Label size={1} muted>Bought</Label></th>
							<th scope="col" style={numericCell}><Label size={1} muted>Test rate</Label></th>
						</tr>
					</thead>
					<tbody>
						{data.rows.map((row) => (
							<tr key={row.typeface}>
								<th scope="row" style={cell}><Text size={1}>{row.typeface}</Text></th>
								<td style={numericCell}><MetricFigure metric={row.viewed} label={`${row.typeface} viewed`} size={1} /></td>
								<td style={numericCell}><MetricFigure metric={row.tested} label={`${row.typeface} tested`} size={1} /></td>
								<td style={numericCell}><MetricFigure metric={row.bought} label={`${row.typeface} bought`} size={1} /></td>
								<td style={numericCell}>
									<Text size={1} muted>{row.testRate === null ? '—' : formatPercent(row.testRate, 1)}</Text>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</Card>
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
	const failing = data.checks.filter((c) => c.status === 'fail').length
	const warning = data.checks.filter((c) => c.status === 'warn').length

	const summary =
		data.verdict === 'pass'
			? 'Everything checked out. The figures in the other panels can be taken at face value.'
			: `${failing} failing, ${warning} worth a look. Panels depending on these will be wrong or incomplete until they are resolved.`

	return (
		<Stack space={4}>
			<Card padding={3} radius={2} tone={CHECK_TONE[data.verdict]} border>
				<Text size={1}>{summary}</Text>
			</Card>

			<Stack space={3}>
				{data.checks.map((item) => (
					<Card key={item.id} padding={3} radius={2} tone="transparent" border>
						<Stack space={3}>
							<Flex align="center" justify="space-between" gap={3}>
								<Text size={1} weight="semibold">{item.label}</Text>
								<Badge tone={CHECK_TONE[item.status]} fontSize={0}>{CHECK_WORD[item.status]}</Badge>
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
