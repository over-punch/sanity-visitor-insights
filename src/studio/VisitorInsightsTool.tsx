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

/**
 * Control rows — range buttons, panel tabs, source status.
 *
 * Real CSS rather than the UI kit's Flex: when the compat shim cannot resolve Flex it renders a
 * plain div and a `gap` token does nothing, which is what put the Caveat badge on top of its own
 * text. Wrapping matters here too, since a Studio pane is resizable and five tabs do not fit a
 * narrow one.
 */
const controlRow: React.CSSProperties = {
	display: 'flex',
	gap: 6,
	alignItems: 'center',
	flexWrap: 'wrap',
}

/**
 * Tab strip.
 *
 * The panels were five loose buttons in a row, which read as five actions rather than one choice
 * between five views — nothing said "these are tabs" except the ARIA role, which only a screen
 * reader ever heard. A shared baseline with the active tab underlined is the convention a reader
 * already knows, and it survives the compat shim falling back to plain elements because it is CSS
 * rather than a component variant.
 */
const tabStrip: React.CSSProperties = {
	display: 'flex',
	gap: 2,
	alignItems: 'stretch',
	flexWrap: 'wrap',
	borderBottom: '1px solid var(--card-border-color, rgba(128,128,128,0.25))',
}

/** One tab. The selected state carries an underline as well as weight, never colour alone. */
function tabStyle(selected: boolean): React.CSSProperties {
	return {
		appearance: 'none',
		background: 'transparent',
		border: 'none',
		borderBottom: `2px solid ${selected ? 'currentColor' : 'transparent'}`,
		color: 'inherit',
		opacity: selected ? 1 : 0.62,
		font: 'inherit',
		fontWeight: selected ? 600 : 400,
		padding: '8px 12px',
		marginBottom: -1,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	}
}

/** One range button. Selected state carries weight and a border, never colour alone. */
function rangeButton(selected: boolean): React.CSSProperties {
	return {
		appearance: 'none',
		background: 'transparent',
		border: `1px solid ${selected ? 'currentColor' : 'var(--card-border-color, rgba(128,128,128,0.3))'}`,
		borderRadius: 3,
		color: 'inherit',
		opacity: selected ? 1 : 0.7,
		font: 'inherit',
		fontSize: '0.85em',
		fontWeight: selected ? 600 : 400,
		padding: '5px 10px',
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	}
}

/** The custom-range form, wrapping on a narrow pane. */
const pickerRow: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }

/** A labelled date field. */
const pickerField: React.CSSProperties = { display: 'grid', gap: 2 }

/** Native date input, inheriting the Studio's type and colours. */
const dateInput: React.CSSProperties = {
	font: 'inherit',
	fontSize: '0.85em',
	padding: '4px 6px',
	borderRadius: 3,
	border: '1px solid var(--card-border-color, rgba(128,128,128,0.3))',
	background: 'transparent',
	color: 'inherit',
	colorScheme: 'light dark',
}

/**
 * Range options.
 *
 * Labelled by the span they actually cover rather than by a calendar word. "Quarter" and "Year"
 * were trailing day counts — 91 and 365 days ending today — not Q3 or a calendar year, and a reader
 * comparing them against anything calendar-aligned would have been comparing different things
 * without being told.
 *
 * The dates each one resolves to are NOT shown beside the buttons — only in each button's `title`
 * tooltip, which is invisible on touch and in a screenshot, and in the footer line beneath all the
 * content. An earlier version of this comment claimed otherwise; the intent was never implemented.
 */
const RANGES: Array<{ key: Exclude<RangeKey, 'custom'>; label: string; span: string }> = [
	{ key: 'week', label: 'Week', span: 'the last 7 days' },
	{ key: 'month', label: 'Month', span: 'the last 30 days' },
	{ key: 'quarter', label: 'Quarter', span: 'the last 91 days' },
	{ key: 'year', label: 'Year', span: 'the last 365 days' },
]

/** Panels, in the order they appear. */
/**
 * Panels, in the order they appear.
 *
 * Acquisition leads because "where did people come from" is the question most often being asked.
 * Measurement health sits near the end deliberately: it is about the instrument rather than the
 * audience, and leading with it made an operational caveat the first thing anyone read. Diagnostics
 * stays last, since it is about configuration rather than visitors at all.
 */
const PANELS: Array<{ report: ReportName; label: string; blurb: string }> = [
	{ report: 'acquisition', label: 'Acquisition', blurb: 'Where visitors come from' },
	{ report: 'journey', label: 'Journey', blurb: 'How far visitors get' },
	{ report: 'typeface-interest', label: 'Typeface interest', blurb: 'Viewed, tested and bought, by family' },
	{ report: 'measurement-health', label: 'Measurement health', blurb: 'How much of reality each source actually sees' },
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
function RangeSelector({
	value,
	custom,
	onChange,
	onCustomChange,
}: {
	value: RangeKey
	custom: { start: string; end: string }
	onChange: (next: RangeKey) => void
	onCustomChange: (next: { start: string; end: string }) => void
}): React.ReactElement {
	const refs = useRef<Array<HTMLButtonElement | null>>([])
	const [pickerOpen, setPickerOpen] = useState(value === 'custom')

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

			setPickerOpen(false)
			onChange(next.key)
			refs.current[nextIndex]?.focus()
		},
		[value, onChange],
	)

	return (
		<Stack space={2}>
			<div role="radiogroup" aria-label="Date range" style={controlRow} onKeyDown={onKeyDown}>
				{RANGES.map((range, index) => {
					const selected = range.key === value
					return (
						// Plain buttons rather than the UI kit's: the compat shim's DOM fallback does not
						// forward `text`, which renders the whole selector as blank boxes on any Studio
						// version where it cannot resolve Button.
						<button
							key={range.key}
							type="button"
							ref={(el: HTMLButtonElement | null) => {
								refs.current[index] = el
							}}
							role="radio"
							aria-checked={selected}
							// Only the selected option is in the tab order, so the group is one stop.
							tabIndex={selected ? 0 : -1}
							title={`Ending today, covering ${range.span}`}
							style={rangeButton(selected)}
							onClick={() => {
								setPickerOpen(false)
								onChange(range.key)
							}}
						>
							{range.label}
						</button>
					)
				})}

				{/* Custom sits outside the radiogroup deliberately: it opens a form rather than
				    selecting a value, so arrowing onto it would open and close the picker. */}
				<button
					type="button"
					style={rangeButton(value === 'custom')}
					aria-expanded={pickerOpen}
					onClick={() => setPickerOpen((open) => !open)}
				>
					{value === 'custom' ? `${custom.start} to ${custom.end}` : 'Custom…'}
				</button>
			</div>

			{pickerOpen && (
				<div style={pickerRow}>
					<label style={pickerField}>
						<Text size={0} muted>From</Text>
						<input
							type="date"
							value={custom.start}
							max={custom.end || undefined}
							style={dateInput}
							onChange={(e) => onCustomChange({ ...custom, start: e.currentTarget.value })}
						/>
					</label>
					<label style={pickerField}>
						<Text size={0} muted>To</Text>
						<input
							type="date"
							value={custom.end}
							min={custom.start || undefined}
							style={dateInput}
							onChange={(e) => onCustomChange({ ...custom, end: e.currentTarget.value })}
						/>
					</label>
					<button
						type="button"
						style={rangeButton(true)}
						// Applied on submit, not on each keystroke: a half-typed year is a valid-looking
						// date, and refetching per character would fire a run of requests nobody asked for.
						disabled={!custom.start || !custom.end}
						onClick={() => onChange('custom')}
					>
						Apply
					</button>
				</div>
			)}
		</Stack>
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
		<div role="tablist" aria-label="Report" style={tabStrip} onKeyDown={onKeyDown}>
			{PANELS.map((panel, index) => {
				const selected = panel.report === value
				return (
					// A plain button rather than the UI kit's, so the label is real children and
					// cannot vanish: the compat shim's DOM fallback does not forward `text`, which
					// would leave five blank tabs on any Studio version where it falls back.
					<button
						key={panel.report}
						type="button"
						ref={(el: HTMLButtonElement | null) => {
							refs.current[index] = el
						}}
						id={`tab-${panel.report}`}
						role="tab"
						aria-selected={selected}
						aria-controls={`panel-${panel.report}`}
						tabIndex={selected ? 0 : -1}
						style={tabStyle(selected)}
						onClick={() => onChange(panel.report)}
					>
						{panel.label}
					</button>
				)
			})}
		</div>
	)
}

/** Renders one report panel, including its loading, error and empty states. */
function ReportPanel({
	report,
	apiBaseUrl,
	range,
	custom,
}: {
	report: ReportName
	apiBaseUrl: string
	range: RangeKey
	custom: { start: string; end: string }
}): React.ReactElement {
	const { state, reload } = useReport<unknown>({ apiBaseUrl, report, range, custom })

	// Announced to screen readers when figures change, so a range switch is perceivable without
	// re-navigating the whole panel.
	const liveMessage =
		state.status === 'loading'
			? 'Loading report'
			: state.status === 'ready'
				? `${report} updated for ${range === 'custom' ? `${custom.start} to ${custom.end}` : `the selected ${range}`}`
				: state.status === 'error'
					? state.disabled
						? 'Visitor insights is switched off for this site'
						: `Report failed: ${state.message}`
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
				// A switched-off site is a configuration state, not a fault: it gets a neutral card
				// and no retry, because retrying cannot change the answer. Everything else keeps
				// the critical tone and the retry.
				<Card padding={4} radius={2} tone={state.disabled ? 'transparent' : 'critical'} border>
					<Stack space={3}>
						{state.disabled && <Text size={1} weight="medium">Switched off</Text>}
						<Text size={1} muted={state.disabled}>{state.message}</Text>
						{!state.disabled && (
							<Box>
								<Button text="Try again" mode="ghost" fontSize={1} onClick={reload} />
							</Box>
						)}
					</Stack>
				</Card>
			)}

			{state.status === 'ready' && (
				<Stack space={4}>
					<SourceStatusRow sources={state.envelope.sources} />
					<NoticeList notices={state.envelope.notices} />

					{state.envelope.comparison && (
						// The baseline is named. A delta whose comparison window is not stated invites
						// the reader to assume a calendar period, when these are trailing windows.
						<Text size={0} muted>
							Changes are against {state.envelope.comparison.range.start} to {state.envelope.comparison.range.end},
							the equivalent window immediately before this one.
						</Text>
					)}

					{report === 'measurement-health' && <MeasurementHealthPanel data={state.envelope.data as never} />}
					{report === 'acquisition' && <AcquisitionPanel data={state.envelope.data as never} previous={state.envelope.comparison?.data as never} />}
					{report === 'journey' && <JourneyPanel data={state.envelope.data as never} />}
					{report === 'typeface-interest' && <TypefaceInterestPanel data={state.envelope.data as never} />}
					{report === 'diagnostics' && <DiagnosticsPanel data={state.envelope.data as never} />}

					<Text size={0} muted>
						Figures cover {state.envelope.range.start} to {state.envelope.range.end}, in {state.envelope.range.timezone}
					</Text>
				</Stack>
			)}
		</Stack>
	)
}

/**
 * An ISO date N days before today, in the viewer's local zone.
 *
 * @param days - how many days back; 0 is today
 */
function isoDaysAgo(days: number): string {
	const date = new Date()
	date.setDate(date.getDate() - days)
	return date.toISOString().slice(0, 10)
}

/** The tool itself. */
export function VisitorInsightsTool(props: VisitorInsightsToolComponentProps): React.ReactElement {
	// Nested options win, since that is the shape the Studio supplies; the flat props are the
	// direct-use fallback. See VisitorInsightsToolComponentProps for why both exist.
	const apiBaseUrl = props.tool?.options?.apiBaseUrl ?? props.apiBaseUrl ?? ''
	// Kept for the document title and accessible naming, no longer printed as a subtitle.
	const siteLabel = props.tool?.options?.siteLabel ?? props.siteLabel ?? ''

	const [range, setRange] = useState<RangeKey>('week')
	// Seeded with the trailing month so the picker opens on a valid range rather than on two empty
	// fields. Local dates, not the property's: this is only the form's starting value, and the
	// server re-resolves whatever is submitted against the property timezone.
	const [custom, setCustom] = useState(() => ({ start: isoDaysAgo(30), end: isoDaysAgo(0) }))
	const [activePanel, setActivePanel] = useState<ReportName>('acquisition')

	const active = PANELS.find((p) => p.report === activePanel) ?? PANELS[0]

	return (
		// Named for assistive technology even though the name is not printed: a Studio user with
		// several tabs open hears which site's figures these are, without the heading repeating
		// what the Studio navigation already says.
		<Container width={4} padding={4} as="section" aria-label={siteLabel ? `Visitor insights for ${siteLabel}` : 'Visitor insights'}>
			<Stack space={5}>
				<Flex align="flex-start" justify="space-between" gap={4} wrap="wrap">
					{/* No site name. The tool is mounted inside that site's own Studio, which already
					    says whose it is in the navigation — repeating it was a line of chrome
					    where the range and its dates are the useful context. */}
					<Heading size={2}>Visitor insights</Heading>
					<RangeSelector value={range} custom={custom} onChange={setRange} onCustomChange={setCustom} />
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
						<ReportPanel report={activePanel} apiBaseUrl={apiBaseUrl} range={range} custom={custom} />
					</Stack>
				</Box>
			</Stack>
		</Container>
	)
}
