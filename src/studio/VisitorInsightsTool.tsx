/**
 * The Visitor Insights Studio tool.
 *
 * One range control drives every panel, implemented once here as a proper radiogroup with
 * roving tabindex — repeating a bespoke toggle per panel is how keyboard behaviour ends up
 * inconsistent between them.
 */

import React, { useCallback, useRef, useState } from 'react'
import { Box, Button, Card, Container, Flex, Heading, Spinner, Stack, Text } from '@liiift-studio/sanity-ui-compat'
import type { RangeKey, ReportName, SourceName, SourceStatus } from '../types'
import { useReport } from './useReport'
import { NoticeList } from './Figure'
import { Badge } from '@liiift-studio/sanity-ui-compat'
import { AcquisitionPanel, DiagnosticsPanel, JourneyPanel, MeasurementHealthPanel, TypefaceInterestPanel } from './panels'

/** Range options, in the order they appear. */
const RANGES: Array<{ key: RangeKey; label: string }> = [
	{ key: 'week', label: 'Week' },
	{ key: 'quarter', label: 'Quarter' },
	{ key: 'year', label: 'Year' },
]

/** Panels, in the order they appear. */
const PANELS: Array<{ report: ReportName; label: string; blurb: string }> = [
	{ report: 'measurement-health', label: 'Measurement health', blurb: 'How much of reality each source actually sees' },
	{ report: 'acquisition', label: 'Acquisition', blurb: 'Where visitors come from' },
	{ report: 'journey', label: 'Journey', blurb: 'How far visitors get, and where they stop' },
	{ report: 'typeface-interest', label: 'Typeface interest', blurb: 'Viewed, tested and bought, by family' },
	{ report: 'diagnostics', label: 'Diagnostics', blurb: 'What to fix before trusting the numbers above' },
]

/** Options supplied by the plugin config, carried on the Sanity tool definition. */
export interface VisitorInsightsToolProps {
	apiBaseUrl: string
	siteLabel: string
}

/**
 * What Sanity actually hands a tool component.
 *
 * Sanity does NOT spread a tool's `options` onto its component's props — it passes the whole tool
 * definition as `tool`, with the options nested inside. Destructuring `apiBaseUrl` straight off
 * props therefore yields undefined, and the first thing useReport does with it is call .replace(),
 * so every panel failed with "Cannot read properties of undefined (reading 'replace')".
 *
 * Both shapes are accepted: the nested one because that is what the Studio passes, and the flat one
 * because the component is exported for direct use and is mounted that way in tests.
 */
export interface VisitorInsightsToolComponentProps extends Partial<VisitorInsightsToolProps> {
	tool?: { options?: Partial<VisitorInsightsToolProps> }
}

/**
 * Range selector.
 * Arrow keys move between options and select as they go, which is the expected behaviour for a
 * radiogroup; Tab enters and leaves the group as a single stop.
 */
function RangeSelector({ value, onChange }: { value: RangeKey; onChange: (next: RangeKey) => void }): React.ReactElement {
	const refs = useRef<Array<HTMLButtonElement | null>>([])

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			const currentIndex = RANGES.findIndex((r) => r.key === value)
			let nextIndex: number | null = null

			if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % RANGES.length
			if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + RANGES.length) % RANGES.length
			if (event.key === 'Home') nextIndex = 0
			if (event.key === 'End') nextIndex = RANGES.length - 1

			if (nextIndex === null) return

			event.preventDefault()
			const next = RANGES[nextIndex]
			if (!next) return

			onChange(next.key)
			refs.current[nextIndex]?.focus()
		},
		[value, onChange],
	)

	return (
		<Flex role="radiogroup" aria-label="Date range" gap={1} onKeyDown={onKeyDown}>
			{RANGES.map((range, index) => {
				const selected = range.key === value
				return (
					<Button
						key={range.key}
						ref={(el: HTMLButtonElement | null) => {
							refs.current[index] = el
						}}
						role="radio"
						aria-checked={selected}
						// Only the selected option is in the tab order, so the group is one stop.
						tabIndex={selected ? 0 : -1}
						mode={selected ? 'default' : 'bleed'}
						tone={selected ? 'primary' : 'default'}
						text={range.label}
						onClick={() => onChange(range.key)}
						fontSize={1}
						padding={3}
					/>
				)
			})}
		</Flex>
	)
}

/** Human labels for the upstreams, so the row does not read as internal jargon. */
const SOURCE_LABEL: Record<SourceName, string> = {
	ga4: 'Google Analytics',
	vercel: 'Vercel',
	sanity: 'Orders',
}

/**
 * Which sources answered.
 *
 * The envelope has carried this from the start and nothing displayed it, so a panel built on two
 * of three sources looked identical to one built on all three. Partial failure is the normal case
 * here — an unconfigured Vercel project, an expired service account — and the difference between
 * "this number is low" and "we could not ask" has to be visible.
 *
 * Renders nothing when everything answered, so the healthy case stays quiet.
 */
function SourceStatusRow({ sources }: { sources: Partial<Record<SourceName, SourceStatus>> }): React.ReactElement | null {
	const degraded = (Object.entries(sources) as Array<[SourceName, SourceStatus]>).filter(([, s]) => s.status !== 'ok')
	if (degraded.length === 0) return null

	return (
		<Card padding={3} radius={2} tone="caution" border>
			<Flex gap={3} align="center" wrap="wrap">
				<Text size={1} weight="semibold">Incomplete data:</Text>
				{degraded.map(([name, status]) => (
					<Flex key={name} gap={2} align="center">
						<Badge tone={status.status === 'error' ? 'critical' : 'default'} fontSize={0}>
							{SOURCE_LABEL[name]}
						</Badge>
						<Text size={1} muted>
							{status.status === 'error' ? status.message : 'not configured for this site'}
						</Text>
					</Flex>
				))}
			</Flex>
		</Card>
	)
}

/**
 * Panel tabs.
 *
 * Hand-rolled rather than taken from @sanity/ui so the keyboard contract is explicit and identical
 * across the Studio versions this package supports: arrow keys move and select, Tab is a single
 * stop into the group, and each tab is wired to its panel by id.
 */
function PanelTabs({ value, onChange }: { value: ReportName; onChange: (next: ReportName) => void }): React.ReactElement {
	const refs = useRef<Array<HTMLButtonElement | null>>([])

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			const currentIndex = PANELS.findIndex((p) => p.report === value)
			let nextIndex: number | null = null

			if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % PANELS.length
			if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + PANELS.length) % PANELS.length
			if (event.key === 'Home') nextIndex = 0
			if (event.key === 'End') nextIndex = PANELS.length - 1

			if (nextIndex === null) return

			event.preventDefault()
			const next = PANELS[nextIndex]
			if (!next) return

			onChange(next.report)
			refs.current[nextIndex]?.focus()
		},
		[value, onChange],
	)

	return (
		<Flex role="tablist" aria-label="Report" gap={1} wrap="wrap" onKeyDown={onKeyDown}>
			{PANELS.map((panel, index) => {
				const selected = panel.report === value
				return (
					<Button
						key={panel.report}
						ref={(el: HTMLButtonElement | null) => {
							refs.current[index] = el
						}}
						id={`tab-${panel.report}`}
						role="tab"
						aria-selected={selected}
						aria-controls={`panel-${panel.report}`}
						tabIndex={selected ? 0 : -1}
						mode={selected ? 'default' : 'bleed'}
						tone={selected ? 'primary' : 'default'}
						text={panel.label}
						onClick={() => onChange(panel.report)}
						fontSize={1}
						padding={3}
					/>
				)
			})}
		</Flex>
	)
}

/** Renders one report panel, including its loading, error and empty states. */
function ReportPanel({ report, apiBaseUrl, range }: { report: ReportName; apiBaseUrl: string; range: RangeKey }): React.ReactElement {
	const { state, reload } = useReport<unknown>({ apiBaseUrl, report, range })

	// Announced to screen readers when figures change, so a range switch is perceivable without
	// re-navigating the whole panel.
	const liveMessage =
		state.status === 'loading'
			? 'Loading report'
			: state.status === 'ready'
				? `${report} updated for the selected ${range}`
				: state.status === 'error'
					? `Report failed: ${state.message}`
					: ''

	return (
		<Stack space={4}>
			<Box aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
				{liveMessage}
			</Box>

			{state.status === 'loading' && (
				<Flex align="center" gap={3} padding={4}>
					<Spinner muted />
					<Text size={1} muted>Loading…</Text>
				</Flex>
			)}

			{state.status === 'error' && (
				<Card padding={4} radius={2} tone="critical" border>
					<Stack space={3}>
						<Text size={1}>{state.message}</Text>
						<Box>
							<Button text="Try again" mode="ghost" fontSize={1} onClick={reload} />
						</Box>
					</Stack>
				</Card>
			)}

			{state.status === 'ready' && (
				<Stack space={4}>
					<SourceStatusRow sources={state.envelope.sources} />
					<NoticeList notices={state.envelope.notices} />

					{report === 'measurement-health' && <MeasurementHealthPanel data={state.envelope.data as never} />}
					{report === 'acquisition' && <AcquisitionPanel data={state.envelope.data as never} />}
					{report === 'journey' && <JourneyPanel data={state.envelope.data as never} />}
					{report === 'typeface-interest' && <TypefaceInterestPanel data={state.envelope.data as never} />}
					{report === 'diagnostics' && <DiagnosticsPanel data={state.envelope.data as never} />}

					<Text size={0} muted>
						{state.envelope.range.start} to {state.envelope.range.end} ({state.envelope.range.timezone})
					</Text>
				</Stack>
			)}
		</Stack>
	)
}

/** The tool itself. */
export function VisitorInsightsTool(props: VisitorInsightsToolComponentProps): React.ReactElement {
	// Nested options win, since that is the shape the Studio supplies; the flat props are the
	// direct-use fallback. See VisitorInsightsToolComponentProps for why both exist.
	const apiBaseUrl = props.tool?.options?.apiBaseUrl ?? props.apiBaseUrl ?? ''
	const siteLabel = props.tool?.options?.siteLabel ?? props.siteLabel ?? ''

	const [range, setRange] = useState<RangeKey>('week')
	const [activePanel, setActivePanel] = useState<ReportName>('measurement-health')

	const active = PANELS.find((p) => p.report === activePanel) ?? PANELS[0]

	return (
		<Container width={4} padding={4}>
			<Stack space={5}>
				<Flex align="flex-start" justify="space-between" gap={4} wrap="wrap">
					<Stack space={2}>
						<Heading size={2}>Visitor insights</Heading>
						<Text size={1} muted>{siteLabel}</Text>
					</Stack>
					<RangeSelector value={range} onChange={setRange} />
				</Flex>

				<PanelTabs value={activePanel} onChange={setActivePanel} />

				<Box
					role="tabpanel"
					id={`panel-${activePanel}`}
					aria-labelledby={`tab-${activePanel}`}
					// Focusable so a keyboard user can Tab straight from the tab into its content.
					tabIndex={0}
					style={{ position: 'relative' }}
				>
					<Stack space={4}>
						{active && <Text size={1} muted>{active.blurb}</Text>}
						<ReportPanel report={activePanel} apiBaseUrl={apiBaseUrl} range={range} />
					</Stack>
				</Box>
			</Stack>
		</Container>
	)
}
