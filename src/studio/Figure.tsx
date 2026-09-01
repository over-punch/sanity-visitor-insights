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

import React from 'react'
import { Badge, Box, Card, Flex, Stack, Text, Tooltip } from '@liiift-studio/sanity-ui-compat'
import type { MetricValue, UnavailableReason } from '../types'

/** Human-readable explanation for each unavailable reason. */
const REASON_TEXT: Record<UnavailableReason, string> = {
	not_instrumented: 'Not tracked on this site',
	before_cutover: 'Not tracked during this period',
	suppressed: 'Withheld by GA4 for privacy',
	outage: 'Not recorded during part of this period',
	source_error: 'Source did not respond',
	not_applicable: 'Does not apply to this site',
}

/** Format a number with thousands separators. */
export function formatCount(value: number): string {
	return new Intl.NumberFormat('en-GB').format(Math.round(value))
}

/** Format a 0–1 ratio as a percentage. */
export function formatPercent(ratio: number, digits = 0): string {
	return `${(ratio * 100).toFixed(digits)}%`
}

/** Props for MetricFigure. */
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
		const reason = REASON_TEXT[metric.reason]
		const detail = metric.detail ? `${reason}. ${metric.detail}` : reason

		return (
			<Tooltip content={<Box padding={2}><Text size={1}>{detail}</Text></Box>} portal>
				<Text size={size} muted aria-label={`${label}: unavailable. ${detail}`}>
					<span aria-hidden="true">—</span>
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
				<Text size={size} aria-label={`${label}: ${formatted}, partial. ${metric.note}`}>
					{formatted}
				</Text>
				<Badge tone="caution" fontSize={0}>Partial</Badge>
			</Stack>
		)
	}

	return (
		<Text size={size} aria-label={`${label}: ${formatted}`}>
			{formatted}
		</Text>
	)
}

/** Props for ComparisonBar. */
export interface ComparisonBarProps {
	label: string
	metric: MetricValue
	/** Largest value across the sibling bars, used to scale width. */
	max: number
	/** Tone conveys category, but never carries meaning on its own. */
	tone?: 'primary' | 'positive' | 'caution' | 'default'
}

/**
 * A horizontal bar with its value printed alongside.
 *
 * Deliberately CSS rather than a charting library: these panels compare and rank a handful of
 * values, which a labelled bar does as well as a chart while avoiding a large dependency in the
 * Studio bundle and the theme-token bridging that a chart library would need for light and dark.
 */
export function ComparisonBar({ label, metric, max, tone = 'default' }: ComparisonBarProps): React.ReactElement {
	const value = metric.status === 'unavailable' ? null : metric.value
	const width = value !== null && max > 0 ? Math.max(2, (value / max) * 100) : 0

	return (
		<Stack space={2}>
			<Flex align="center" justify="space-between" gap={3}>
				<Text size={1} weight="medium">{label}</Text>
				<MetricFigure metric={metric} label={label} size={1} />
			</Flex>

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
				// Track and fill are both Cards so the palette comes from the Studio theme tokens
				// rather than hand-picked CSS variables, and follows light/dark without extra work.
				<Card aria-hidden="true" radius={2} tone="transparent" border style={{ height: 8, overflow: 'hidden' }}>
					<Card tone={tone === 'default' ? 'default' : tone} radius={2} style={{ width: `${width}%`, height: '100%' }} />
				</Card>
			)}
		</Stack>
	)
}

/** Props for NoticeList. */
export interface NoticeListProps {
	notices: string[]
}

/**
 * Caveats attached to a report — sampling, processing lag, instrumentation cutovers.
 * Rendered in the panel rather than a README: a caveat nobody sees does not prevent a wrong read.
 */
export function NoticeList({ notices }: NoticeListProps): React.ReactElement | null {
	if (notices.length === 0) return null

	// A real list element, so a screen reader announces how many caveats there are. The compat
	// shim's Stack does not forward `as`, so the semantics are set on plain elements here.
	return (
		<ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
			{notices.map((notice) => (
				<li key={notice}>
					<Card padding={3} radius={2} tone="caution" border>
						<Flex gap={3} align="flex-start">
							<Badge tone="caution" fontSize={0}>Caveat</Badge>
							<Text size={1}>{notice}</Text>
						</Flex>
					</Card>
				</li>
			))}
		</ul>
	)
}
