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
	const hex = SERIES[key]
	const r = parseInt(hex.slice(1, 3), 16)
	const g = parseInt(hex.slice(3, 5), 16)
	const b = parseInt(hex.slice(5, 7), 16)
	return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

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
