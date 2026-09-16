/**
 * The series palette, and the rules that keep it honest.
 *
 * Every chart in this package was drawn in `currentColor` at varying alpha, so five series on one
 * chart were five greys separated by dash pattern alone. That is legible in a screenshot and not
 * in use: a reader tracking co-movement between GA4 and Vercel had to keep which-line-is-which in
 * their head while looking at the shape.
 *
 * Three constraints decided these values, and all three are enforced by tests rather than asserted
 * here:
 *
 * 1. ONE SET FOR BOTH THEMES. The Studio ships light and dark and this component is not told which
 *    it is in. Rather than swap palettes at a breakpoint we cannot observe, every colour clears
 *    3:1 — the WCAG floor for a graphical object — against BOTH a white card and Sanity's dark
 *    card. That is what pins them to mid-lightness.
 *
 * 2. HUE FAMILY MEANS SOURCE. The two GA4 series are deliberately neighbours in the warm range,
 *    because they are the same instrument measuring two things; Vercel, orders and revenue each
 *    get their own family. So the palette carries a fact rather than just distinguishing rows.
 *
 * 3. COLOUR IS NEVER THE ONLY CHANNEL. Completeness stays encoded as a dash pattern and every
 *    value stays readable in the tooltip. The two GA4 hues are close enough to converge for a
 *    deuteranope — which is acceptable precisely because dash and label still separate them, and
 *    unacceptable for any pair that does not have that second channel.
 */

/** One series colour. The key names what it measures, not what it looks like. */
export type SeriesKey = 'vercel' | 'ga4Pageviews' | 'ga4Sessions' | 'orders' | 'revenue'

/**
 * The series colours.
 *
 * Mid-lightness by necessity, not taste — see constraint 1 above. Changing any value here without
 * re-running `palette.test.ts` will silently break a theme nobody is looking at.
 */
export const SERIES: Record<SeriesKey, string> = {
	/** The complete, server-side count. The reference every other line is read against. */
	vercel: '#4C8FD0',
	/** GA4's pageviews — the like-for-like counterpart to Vercel's. */
	ga4Pageviews: '#DD6B3F',
	/** GA4's sessions. Warm, like its sibling above: same instrument, different unit. */
	ga4Sessions: '#BC861F',
	/** Orders, from the foundry's own records. Exact. */
	orders: '#2E9E6B',
	/** Revenue, same source, different unit. */
	revenue: '#BF5D9B',
}

/**
 * Alpha for a filled region drawn in a series colour.
 *
 * Regions sit under lines and behind labels, so they are held well below the stroke's weight. The
 * shortfall region is the one exception the panel makes, and it says so where it draws it.
 */
export const REGION_ALPHA = 0.18

/**
 * A series colour at a given alpha, as an `rgba()` string.
 *
 * SVG `fill-opacity` would be simpler, but it multiplies with any opacity already on the parent
 * group and these fills sit inside groups that carry their own. Baking the alpha into the colour
 * keeps a region's weight the same wherever it is mounted.
 *
 * @param key - which series
 * @param alpha - 0 to 1
 */
export function seriesFill(key: SeriesKey, alpha: number = REGION_ALPHA): string {
	return withAlpha(SERIES[key], alpha)
}

/**
 * Any hex at a given alpha, as an `rgba()` string.
 *
 * @param hex - the colour
 * @param alpha - 0 to 1
 */
export function withAlpha(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16)
	const g = parseInt(hex.slice(3, 5), 16)
	const b = parseInt(hex.slice(5, 7), 16)
	return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * The comparison identity: every figure, mark and control that refers to the OTHER window.
 *
 * Deliberately outside `SERIES`, because it names a RELATIONSHIP rather than a source. A delta, the
 * ghost line behind a series, and the basis toggle that chooses between "previous period" and "last
 * year" are one idea, and before this they were three greys at three opacities plus an underline on
 * one tone — so nothing on screen said they were related, which is exactly what a reader asked for.
 *
 * Hue 255 sits in the widest gap in the series ring (vercel 210 to revenue 322). Its nearest
 * neighbour under deuteranopia is vercel at dE 12.2 — wider than the ga4Pageviews/ga4Sessions pair
 * this palette already ships on purpose, and 57 from the neutral grey it replaces, which is what
 * lets it read as an identity rather than as more muting.
 *
 * 4.29:1 on white and 4.28:1 on Sanity's dark card. For this pair of grounds 4.285 is the ceiling
 * any single colour can reach on both sides at once, so this is the balance point, not a
 * compromise. It only holds at FULL ALPHA: at 0.9 it is 3.6, at 0.7 it is 2.6, at 0.55 it is 2.1.
 * That is why the opacity ladder that used to carry emphasis had to go rather than be tinted.
 */
export const COMPARISON = '#8368D4'

/**
 * The comparison colour as TEXT, which needs a higher floor than a mark does.
 *
 * `COMPARISON` is balanced to sit as well as possible on both grounds at once, and 4.285:1 is the
 * arithmetic ceiling for that: make it lighter and the white card fails, darker and the dark card
 * does. That clears the 3:1 a graphical object needs, and it is what every comparison MARK uses.
 *
 * But the identity is also worn by the deltas, their baselines, the toggle's label and the sentence
 * naming the window — all of them small text, which WCAG 1.4.3 holds to 4.5:1. No single colour can
 * reach that on both grounds, so text gets a pair, one per ground, and the browser picks.
 *
 * The pair is selected off Sanity's own `data-scheme` attribute. An earlier version used
 * `light-dark()` on `:root` — which measured correctly in isolation and was wrong in the Studio,
 * because Sanity sets `color-scheme` on the CARD, not on the root. At `:root` the used scheme is
 * `normal`, `light-dark()` resolves to its light half, and a dark Studio would have rendered the
 * light colour at 3.09:1 — worse than the balanced colour it replaced. Verified in the browser
 * rather than reasoned about: the outermost Card carries `data-scheme="dark"` with background
 * #13141b, and `data-scheme="light"` with #ffffff, which are exactly the two grounds this module
 * measures against.
 *
 * Every use site keeps the balanced colour as its `var()` fallback, so if that attribute ever
 * changes the identity degrades to where it started rather than disappearing.
 */
export const COMPARISON_TEXT = `var(--vi-comparison, ${COMPARISON})`

/** The text pair. Same hue family as COMPARISON, so the identity survives the theme switch. */
export const COMPARISON_ON_LIGHT = '#6A4FC4'
export const COMPARISON_ON_DARK = '#A594E8'

/**
 * The stylesheet that defines `--vi-comparison`, rendered once by the tool.
 *
 * A custom property rather than an inline style because an inline style cannot carry a fallback:
 * React sets one value per key, so there would be no way to say "this colour, or that one if the
 * ground is dark" without knowing the theme at render time, which this package deliberately does
 * not.
 */
export const COMPARISON_STYLE = `
:root { --vi-comparison: ${COMPARISON}; }
[data-scheme="light"] { --vi-comparison: ${COMPARISON_ON_LIGHT}; }
[data-scheme="dark"] { --vi-comparison: ${COMPARISON_ON_DARK}; }
`.trim()

/** The grounds a colour has to work on: Sanity's light card and its dark one. */
export const GROUNDS = { light: '#ffffff', dark: '#13141b' } as const

/** Relative luminance, per WCAG 2.1. */
export function luminance(hex: string): number {
	const channel = (raw: number): number => {
		const c = raw / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}
	const r = channel(parseInt(hex.slice(1, 3), 16))
	const g = channel(parseInt(hex.slice(3, 5), 16))
	const b = channel(parseInt(hex.slice(5, 7), 16))
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast ratio between two colours, per WCAG 2.1. Symmetric, 1 to 21. */
export function contrast(a: string, b: string): number {
	const la = luminance(a)
	const lb = luminance(b)
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---------------------------------------------------------------------------
// The mark registry
// ---------------------------------------------------------------------------

/**
 * What a mark is for, which decides whether 3:1 applies to it.
 *
 * `data` — carries a value the reader must perceive: a line, a bar, a stem. WCAG 1.4.11 applies.
 * `fill` — a region tinted behind or beneath data. Deliberately light so what it covers stays
 *          readable, so it CANNOT carry 3:1 and must name a `boundary` mark that does.
 * `furniture` — rails, grids, baselines. Not a value; exempt, but still drawn visibly.
 */
export type MarkRole = 'data' | 'fill' | 'furniture'

/** One drawn mark: the colour, the alpha it is ACTUALLY drawn at, and what it is for. */
export interface Mark {
	key: SeriesKey | 'neutral' | 'comparison'
	/** The opacity the renderer applies. This is the number the contrast test composites with. */
	alpha: number
	role: MarkRole
	/** For a `fill`: the `data` mark whose stroke makes this region's extent perceivable. */
	boundary?: string
	/** Why this mark exists, for the next person reading the test output. */
	note: string
}

/**
 * Every mark this package draws.
 *
 * THIS IS THE POINT OF THIS MODULE. The previous version exported five hex constants, asserted 3:1
 * against them, and left each renderer free to multiply by whatever opacity it liked — so the test
 * validated a colour that was never drawn, and the shipped shortfall region sat at 1.40:1 while a
 * green suite said the palette was sound. Twenty-nine tests, mutation-checked, all measuring a
 * constant.
 *
 * Renderers read their alpha from here. The test walks this registry and composites each entry over
 * both grounds. The two cannot drift, because they are the same object.
 */
export const MARKS: Record<string, Mark> = {
	'chart.line': { key: 'vercel', alpha: 1, role: 'data', note: 'A source series in the timeline' },
	'chart.lossyLine': { key: 'ga4Pageviews', alpha: 1, role: 'data', note: 'The lossier source, dashed' },
	'chart.coverage': { key: 'ga4Sessions', alpha: 1, role: 'data', note: 'Share one source saw of another' },
	'chart.stem': { key: 'orders', alpha: 1, role: 'data', note: 'One day that had orders' },
	'chart.zeroTick': { key: 'orders', alpha: 1, role: 'data', note: 'A day MEASURED at zero — the package\'s founding distinction' },
	// Renamed from `chart.regionEdge`. It was the boundary of a filled region; the region is gone —
	// its width was the absolute gap, which under a flat coverage rate is the traffic curve scaled
	// down, so it widened on busy days with no change in the instrument. This is now simply the
	// lossier source's own line, which is what the collapse detector and the spoken summary read.
	'chart.lossy': { key: 'ga4Pageviews', alpha: 1, role: 'data', note: 'The lossier source\'s own level, dashed beneath the complete one' },
	'chart.ghost': { key: 'comparison', alpha: 1, role: 'data', note: 'The same window last period, behind everything' },
	'chart.grid': { key: 'neutral', alpha: 0.18, role: 'furniture', note: 'Grid rules' },
	'bar.fill': { key: 'vercel', alpha: 1, role: 'data', note: 'Every proportion, comparison and funnel bar' },
	'bar.track': { key: 'neutral', alpha: 0.12, role: 'furniture', note: 'The rail a bar sits in' },
	// Neither a source nor money. It was drawn in the REVENUE hue, so a magenta bar between funnel
	// rungs read as takings; GA4's hue was rejected for the opposite reason, since that hue means
	// "this instrument measured it" everywhere else. People who did not continue are an absence, so
	// they take the neutral — which clears 4.00:1 light and 4.59:1 dark at full alpha.
	'bar.lost': { key: 'neutral', alpha: 1, role: 'data', note: 'People who did not continue past a funnel rung' },
	'bar.seen': { key: 'ga4Pageviews', alpha: 1, role: 'data', note: 'The share of a complete count that the lossy source saw' },
	'estimate.dot': { key: 'ga4Pageviews', alpha: 1, role: 'data', note: 'One independent estimate of how much GA4 sees' },
	'estimate.interval': { key: 'ga4Pageviews', alpha: 0.35, role: 'fill', boundary: 'estimate.dot', note: 'How wide the sample leaves that estimate — the dot is its own boundary' },
	'estimate.rule': { key: 'neutral', alpha: 0.45, role: 'furniture', note: 'The 100% reference a capture rate is read against' },
	// A segment per colour rather than a dash pattern per segment. Dash was the ONLY channel
	// separating these lines, and it is the one channel `preserveAspectRatio="none"` distorted —
	// so two segments could be drawn identically on a wide pane. The keys are reused from the
	// series palette because they already clear 3:1 on both grounds; they carry no source meaning
	// here, and the legend states which is which.
	'survival.line': { key: 'vercel', alpha: 1, role: 'data', note: 'The first audience segment falling through a funnel' },
	'survival.line.2': { key: 'ga4Pageviews', alpha: 1, role: 'data', note: 'The second audience segment' },
	'survival.line.3': { key: 'orders', alpha: 1, role: 'data', note: 'The third audience segment' },
	'survival.line.4': { key: 'revenue', alpha: 1, role: 'data', note: 'The fourth audience segment' },
	'survival.grid': { key: 'neutral', alpha: 0.18, role: 'furniture', note: 'The 50% and 100% references a survival line is read against' },
}

/**
 * The rgba a mark is drawn in.
 *
 * @param name - a key of MARKS
 */
export function mark(name: string): string {
	const m = MARKS[name]
	if (!m) throw new Error(`Unknown mark: ${name}`)
	return withAlpha(baseHex(m.key), m.alpha)
}

/**
 * The hex a mark key resolves to, before its alpha is applied.
 *
 * Exported so the contrast test composites the SAME colour the renderer draws. It had its own copy
 * of this mapping; the moment a third kind of key existed, that copy returned undefined.
 *
 * @param key - a series, the neutral, or the comparison identity
 */
export function baseHex(key: SeriesKey | 'neutral' | 'comparison'): string {
	if (key === 'neutral') return NEUTRAL
	if (key === 'comparison') return COMPARISON
	return SERIES[key]
}

/** The grey used for furniture that belongs to no series. */
export const NEUTRAL = '#7f7f7f'

/**
 * Composite a colour at an alpha over a ground, so contrast can be measured as DRAWN.
 *
 * @param hex - the mark colour
 * @param alpha - the opacity the renderer applies
 * @param ground - what it is drawn on top of
 */
export function composite(hex: string, alpha: number, ground: string): string {
	const mix = (at: number): number => Math.round(
		parseInt(hex.slice(at, at + 2), 16) * alpha + parseInt(ground.slice(at, at + 2), 16) * (1 - alpha),
	)
	const hexOf = (n: number) => n.toString(16).padStart(2, '0')
	return `#${hexOf(mix(1))}${hexOf(mix(3))}${hexOf(mix(5))}`
}
