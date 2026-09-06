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
import { daysBetween, shiftDays } from '../core/ranges'
import { NoticeList } from './Figure'
import { Badge } from '@liiift-studio/sanity-ui-compat'
import { AcquisitionPanel, DataHealthPanel, JourneyPanel, OverviewPanel, TypefaceInterestPanel } from './panels'

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

/** The context line under the tabs, saying what the panels are currently narrowed to. */
const contextRow: React.CSSProperties = {
	display: 'flex',
	gap: 12,
	alignItems: 'baseline',
	flexWrap: 'wrap',
}

/** Clearing the narrowed span. Text, not a button-looking control — it is an undo, not an action. */
const inlineClear: React.CSSProperties = {
	appearance: 'none',
	background: 'transparent',
	border: 'none',
	color: 'inherit',
	font: 'inherit',
	fontSize: '0.8em',
	opacity: 0.75,
	padding: 0,
	textDecoration: 'underline',
	textUnderlineOffset: 3,
	cursor: 'pointer',
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
/**
 * The tabs, in the order a reader meets them.
 *
 * `id` is the tab; `report` is the primary envelope it needs. They are no longer the same thing,
 * because Overview and Data health are two halves of one report — the business half and the
 * instrument half — which used to be a single tab named for the instrument. Revenue, orders, the
 * mailing list and the cross-source timeline were all behind it, on tab four, under a blurb saying
 * it was about how much of reality each source sees.
 *
 * Still five tabs. Overview takes the slot freed by folding Diagnostics into Data health, which
 * answers the same question it did — can I trust this — and did not need a tab of its own.
 */
const PANELS: Array<{ id: string; report: ReportName; label: string; blurb: string }> = [
	{ id: 'overview', report: 'measurement-health', label: 'Overview', blurb: 'Money, traffic and what moved this period' },
	{ id: 'acquisition', report: 'acquisition', label: 'Acquisition', blurb: 'Where visitors come from' },
	{ id: 'journey', report: 'journey', label: 'Journey', blurb: 'How far visitors get' },
	{ id: 'typeface-interest', report: 'typeface-interest', label: 'Typeface interest', blurb: 'Viewed, tested and bought, by family' },
	{ id: 'data-health', report: 'measurement-health', label: 'Data health', blurb: 'Whether the numbers above can be trusted' },
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
	// The picker edits a DRAFT and lifts it only on Apply.
	//
	// The comment below promised apply-on-submit and delivered it only on first entry into custom
	// mode, because Apply was what set the range. After a brush the range is ALREADY custom, so
	// every keystroke in a date field updated the live range and fanned out to four upstreams —
	// spinning the year field is several full fetches against a ten-concurrent ceiling.
	const [draft, setDraft] = useState(custom)
	// Re-seeded whenever the committed range changes from outside, e.g. by a brush, so opening the
	// picker shows the window the reader is actually looking at.
	React.useEffect(() => { setDraft(custom) }, [custom.start, custom.end])

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
			<div style={controlRow}>
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
							// Falls back to the first option when nothing is selected. A roving tabindex
							// with no fallback dropped the whole group out of the tab order the moment
							// the range became `custom` — which is exactly what brushing sets, so the
							// reward for using the keyboard-reachable brush was a mouse-only range
							// control.
							tabIndex={selected || (!RANGES.some((r) => r.key === value) && index === 0) ? 0 : -1}
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

			</div>

			{/* OUTSIDE the radiogroup element, not merely outside its arrow cycle. It was a tabbable
			    non-radio child of role="radiogroup" — an ARIA violation, and a second tab stop inside
			    a group documented as being one. */}
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
							value={draft.start}
							max={draft.end || undefined}
							style={dateInput}
							onChange={(e) => setDraft((d) => ({ ...d, start: e.currentTarget.value }))}
						/>
					</label>
					<label style={pickerField}>
						<Text size={0} muted>To</Text>
						<input
							type="date"
							value={draft.end}
							min={draft.start || undefined}
							style={dateInput}
							onChange={(e) => setDraft((d) => ({ ...d, end: e.currentTarget.value }))}
						/>
					</label>
					<button
						type="button"
						style={rangeButton(true)}
						// Applied on submit, not on each keystroke: a half-typed year is a valid-looking
						// date, and refetching per character would fire a run of requests nobody asked for.
						disabled={!draft.start || !draft.end}
						onClick={() => { onCustomChange(draft); onChange('custom') }}
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
	mailchimp: 'Mailchimp',
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
function PanelTabs({ value, onChange }: { value: string; onChange: (next: string) => void }): React.ReactElement {
	const refs = useRef<Array<HTMLButtonElement | null>>([])

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			const currentIndex = PANELS.findIndex((p) => p.id === value)
			let nextIndex: number | null = null

			if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % PANELS.length
			if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + PANELS.length) % PANELS.length
			if (event.key === 'Home') nextIndex = 0
			if (event.key === 'End') nextIndex = PANELS.length - 1

			if (nextIndex === null) return

			event.preventDefault()
			const next = PANELS[nextIndex]
			if (!next) return

			onChange(next.id)
			refs.current[nextIndex]?.focus()
		},
		[value, onChange],
	)

	return (
		<div role="tablist" aria-label="Report" style={tabStrip} onKeyDown={onKeyDown}>
			{PANELS.map((panel, index) => {
				const selected = panel.id === value
				return (
					// A plain button rather than the UI kit's, so the label is real children and
					// cannot vanish: the compat shim's DOM fallback does not forward `text`, which
					// would leave five blank tabs on any Studio version where it falls back.
					<button
						key={panel.id}
						type="button"
						ref={(el: HTMLButtonElement | null) => {
							refs.current[index] = el
						}}
						id={`tab-${panel.id}`}
						role="tab"
						aria-selected={selected}
						aria-controls={`panel-${panel.id}`}
						tabIndex={selected ? 0 : -1}
						style={tabStyle(selected)}
						onClick={() => onChange(panel.id)}
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
	tabId,
	report,
	apiBaseUrl,
	range,
	custom,
	onBrush,
}: {
	/** The tab being drawn. No longer the same as `report`: two tabs share one envelope. */
	tabId: string
	report: ReportName
	apiBaseUrl: string
	range: RangeKey
	custom: { start: string; end: string }
	onBrush?: (start: string, end: string) => void
}): React.ReactElement {
	const { state, reload } = useReport<unknown>({ apiBaseUrl, report, range, custom })
	// Data health additionally shows the configuration checks. Fetched only on that tab, so the
	// four tabs that do not show them do not pay for them.
	// A fixed range: runDiagnostics takes none — it probes the present configuration — so keying it
	// on the selected range fired an identical set of live GA4, Vercel and Sanity probes on every
	// Week→Month→Quarter switch and cached three copies of one answer.
	const diagnostics = useReport<unknown>({
		apiBaseUrl,
		report: 'diagnostics',
		range: 'week',
		enabled: tabId === 'data-health',
	}).state

	// Announced to screen readers when figures change, so a range switch is perceivable without
	// re-navigating the whole panel.
	const liveMessage =
		state.status === 'loading'
			? 'Loading report'
			: state.status === 'ready'
				? `${PANELS.find((p) => p.id === tabId)?.label ?? tabId} updated for ${range === 'custom' ? `${custom.start} to ${custom.end}` : `the selected ${range}`}`
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

			{state.status === 'ready' && state.stale && (
				// A quiet marker, and nothing else. The panel used to render at 0.55 opacity while
				// stale — but every cache hit and every range change sets that flag, so the dominant
				// felt state of the tool was "slightly unreadable", and muted text at 55% is under
				// 3:1 in both themes. The line says it; the figures stay legible.
				<Text size={0} muted>Updating…</Text>
			)}

			{state.status === 'ready' && state.revalidationError && (
				<Card padding={3} radius={2} tone="caution" border>
					<Text size={1}>
						These figures are the last ones that loaded. Refreshing them failed: {state.revalidationError}
					</Text>
				</Card>
			)}

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
								{/* A plain button. The shim's DOM fallback drops `text`, `mode` and `fontSize`, so
								    this rendered as an unlabelled zero-size control — on the one screen
								    where the reader most needs a working one. Every other control in this
								    file already avoids Button for that reason; the error state did not
								    get the lesson. */}
								<button type="button" style={rangeButton(false)} onClick={reload}>Try again</button>
							</Box>
						)}
					</Stack>
				</Card>
			)}

			{state.status === 'ready' && (
				<Stack space={4}>
					<SourceStatusRow sources={state.envelope.sources} />
					<NoticeList notices={state.envelope.notices} />

					{/* Shown only on the panels that actually draw a delta. It used to render whenever
					    `comparison` merely existed, which told the reader they were looking at
					    period-over-period changes on two panels showing bare levels. */}
					{/* Gated on the TAB. It was gated on the report, and the tab/report decoupling made those
					    different things — Data health's report is measurement-health, so it printed
					    "Changes are against…" above a panel that draws not one delta, which is
					    verbatim the bug the comment here says was fixed. */}
				{state.envelope.comparison && COMPARED_TABS.includes(tabId) && (
						<Text size={0} muted>
							Changes are against {state.envelope.comparison.range.start} to {state.envelope.comparison.range.end},
							the equivalent window immediately before this one.
							{state.envelope.comparison.provisional && (
								<> This window&rsquo;s last days are still being processed by GA4, so changes read low.</>
							)}
						</Text>
					)}

					{tabId === 'overview' && <OverviewPanel data={state.envelope.data as never} previous={state.envelope.comparison?.data as never} onBrush={onBrush} />}
					{tabId === 'data-health' && (
						<Stack space={4}>
							<DataHealthPanel
								data={state.envelope.data as never}
								diagnostics={diagnostics.status === 'ready' ? (diagnostics.envelope.data as never) : undefined}
							/>
							{/* Said, not silently absent. The configuration block rendered only on
							    `ready`, so an in-flight fetch or a 500 showed nothing at all and the
							    section popped in later with no explanation of where it had been. */}
							{diagnostics.status === 'loading' && <Text size={1} muted>Checking configuration…</Text>}
							{diagnostics.status === 'error' && (
								<Card padding={3} radius={2} tone="caution" border>
									<Text size={1}>Configuration checks could not run: {diagnostics.message}</Text>
								</Card>
							)}
						</Stack>
					)}
					{tabId === 'acquisition' && <AcquisitionPanel data={state.envelope.data as never} previous={state.envelope.comparison?.data as never} />}
					{tabId === 'journey' && <JourneyPanel data={state.envelope.data as never} />}
					{tabId === 'typeface-interest' && <TypefaceInterestPanel data={state.envelope.data as never} />}

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
	// Stepped in UTC throughout. It previously shifted the date in LOCAL time and then serialised
	// with toISOString(), which is UTC — so anyone east of UTC got a default range one day short.
	const now = new Date()
	const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
	return new Date(utcMidnight - days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Reports that draw a period-over-period delta. Must match the server's own list, which decides
 * which reports pay for a second window.
 */
const COMPARED_REPORTS: ReportName[] = ['acquisition', 'measurement-health']

/** Tabs that actually draw a delta. Not the same as the reports that fetch a comparison window. */
const COMPARED_TABS = ['overview', 'acquisition']

/**
 * Catches a render error in one panel so it does not blank the whole tool.
 *
 * There was no boundary anywhere. An uncaught throw unmounts the entire React tree, so a single bad
 * field reference took out the tabs and the range selector along with the panel — which is what
 * happened twice, and both times the reader lost four working panels to fix one.
 */
class PanelBoundary extends React.Component<
	{ children: React.ReactNode },
	{ error: Error | null }
> {
	constructor(props: { children: React.ReactNode }) {
		super(props)
		this.state = { error: null }
	}

	static getDerivedStateFromError(error: Error) {
		return { error }
	}

	componentDidCatch(error: Error) {
		console.error('Visitor insights: panel render failed:', error.message)
	}

	render() {
		if (!this.state.error) return this.props.children
		return (
			<Card padding={4} radius={2} tone="critical" border>
				<Stack space={3}>
					<Text size={1} weight="medium">This panel could not be drawn</Text>
					<Text size={1}>
						The other panels are unaffected. This usually means the site&rsquo;s API route is a
						different version from this Studio — redeploying the site normally clears it.
					</Text>
					<Text size={0} muted>{this.state.error.message}</Text>
					{/* No retry button. The crash class this catches is a version-skew field access,
					    which is deterministic: clearing the error re-renders the identical subtree
					    against the identical cached envelope and throws again immediately. The
					    previous button called setActivePanel with the value it already had, so React
					    bailed out and nothing refetched — it did nothing twice over. Switching tabs
					    resets the boundary, which is the honest escape. */}
					<Text size={0} muted>Switch tabs and back, or redeploy the site, to clear this.</Text>
				</Stack>
			</Card>
		)
	}
}

/** The tool itself. */
export function VisitorInsightsTool(props: VisitorInsightsToolComponentProps): React.ReactElement {
	// Nested options win, since that is the shape the Studio supplies; the flat props are the
	// direct-use fallback. See VisitorInsightsToolComponentProps for why both exist.
	const apiBaseUrl = props.tool?.options?.apiBaseUrl ?? props.apiBaseUrl ?? ''
	// Kept for the document title and accessible naming, no longer printed as a subtitle.
	const siteLabel = props.tool?.options?.siteLabel ?? props.siteLabel ?? ''

	const [range, setRange] = useState<RangeKey>('week')
	// The range in force before a brush, so the escape hatch returns where the reader was rather
	// than to a week they never chose. Brushing from Quarter and landing in Week loses 358 days,
	// and the label said so — a stated wrong answer rather than a bug you could rationalise.
	const [rangeBeforeBrush, setRangeBeforeBrush] = useState<RangeKey>('week')
	// Seeded with the trailing month so the picker opens on a valid range rather than on two empty
	// fields. Local dates, not the property's: this is only the form's starting value, and the
	// server re-resolves whatever is submitted against the property timezone.
	const [custom, setCustom] = useState(() => ({ start: isoDaysAgo(30), end: isoDaysAgo(0) }))
	const [activePanel, setActivePanel] = useState<string>('overview')

	const active = PANELS.find((p) => p.id === activePanel) ?? PANELS[0]

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

				{/* The constraint, stated where it applies, on every panel.
				    Once a span can be dragged, a reader is regularly in a window nobody chose from
				    a menu — and the only indication of it was a footer line below all the content. */}
				{range === 'custom' && (
					<div style={contextRow}>
						<Text size={0} muted>
							{/* Not always "narrowed": a custom range can be wider than a week, up to the
							    two-year cap. */}
							Showing {custom.start} to {custom.end} ({daysBetween(custom.start, custom.end)} days).
							{daysBetween(custom.start, custom.end) < 14 && (
								<> Short windows lose GA4&rsquo;s low-count rows, so the source and typeface
								lists will be shorter than reality.</>
							)}
						</Text>
						{/* Stepping, because a brush only ever goes inward. Every selection is drawn on
						    the current window, so successive brushes narrow and narrow again with no
						    way to widen, pan, or ask the obvious follow-up — "was the week before
						    like this?" The span shifts by its own length, which is the same window
						    the server already computes for the comparison. */}
						<button
							type="button"
							style={inlineClear}
							aria-label="Shift the window back by its own length"
							onClick={() => {
								const span = daysBetween(custom.start, custom.end)
								setCustom({ start: shiftDays(custom.start, -span), end: shiftDays(custom.end, -span) })
							}}
						>
							← earlier
						</button>
						<button
							type="button"
							style={inlineClear}
							aria-label="Shift the window forward by its own length"
							onClick={() => {
								const span = daysBetween(custom.start, custom.end)
								setCustom({ start: shiftDays(custom.start, span), end: shiftDays(custom.end, span) })
							}}
						>
							later →
						</button>
						<button type="button" style={inlineClear} onClick={() => setRange(rangeBeforeBrush)}>
							Back to the {RANGES.find((r) => r.key === rangeBeforeBrush)?.label.toLowerCase() ?? 'week'}
						</button>
					</div>
				)}

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
						{/* Keyed on the tab, so a throw on one panel does not render the error card for
						    every other. Without the key the boundary held `error` forever and its own
						    copy — "The other panels are unaffected" — became false. */}
						<PanelBoundary key={activePanel}>
							<ReportPanel
								tabId={active?.id ?? 'overview'}
								report={active?.report ?? 'measurement-health'}
								apiBaseUrl={apiBaseUrl}
								range={range}
								custom={custom}
								onBrush={(start, end) => { if (range !== 'custom') setRangeBeforeBrush(range); setCustom({ start, end }); setRange('custom') }}
							/>
						</PanelBoundary>
					</Stack>
				</Box>
			</Stack>
		</Container>
	)
}
