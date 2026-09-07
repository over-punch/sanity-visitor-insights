/**
 * Tests for the series palette.
 *
 * A palette is the kind of thing that looks fine to whoever picked it and fails for someone else's
 * eyes, someone else's theme, or someone else's monitor. These encode the three constraints the
 * module documents, so a later "just nudge that blue" cannot quietly break a theme nobody has open
 * or a reader nobody asked.
 */

import { describe, expect, it } from 'vitest'
import { GROUNDS, REGION_ALPHA, SERIES, contrast, luminance, seriesFill, type SeriesKey } from './palette'

/** Simulate how a colour appears to a dichromat, via the standard LMS projection. */
function simulate(hex: string, kind: 'deuteranopia' | 'protanopia'): [number, number, number] {
	const toLinear = (raw: number): number => {
		const c = raw / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}
	const rgb: [number, number, number] = [
		toLinear(parseInt(hex.slice(1, 3), 16)),
		toLinear(parseInt(hex.slice(3, 5), 16)),
		toLinear(parseInt(hex.slice(5, 7), 16)),
	]
	const RGB_TO_LMS = [[0.31399, 0.63951, 0.04649], [0.15537, 0.75789, 0.08670], [0.01775, 0.10945, 0.87255]]
	const LMS_TO_RGB = [[5.47221, -4.64196, 0.16963], [-1.12524, 2.29317, -0.16789], [0.02980, -0.19318, 1.16364]]
	const PROJECT = {
		deuteranopia: [[1, 0, 0], [0.49421, 0, 1.24827], [0, 0, 1]],
		protanopia: [[0, 1.05118, -0.05116], [0, 1, 0], [0, 0, 1]],
	}[kind]
	const apply = (m: number[][], v: number[]): [number, number, number] =>
		[0, 1, 2].map((i) => (m[i] as number[]).reduce((sum, k, j) => sum + k * (v[j] as number), 0)) as [number, number, number]
	const projected = apply(LMS_TO_RGB, apply(PROJECT, apply(RGB_TO_LMS, rgb)))
	// Back to sRGB before anything measures a distance. Compared in LINEAR light, every distance
	// comes out compressed toward the dark end and two colours a reader can easily tell apart score
	// as a near-collision — which is how this test first read a sound palette as broken.
	const encode = (c: number): number => {
		const clamped = Math.min(1, Math.max(0, c))
		return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
	}
	return projected.map(encode) as [number, number, number]
}

/** Straight-line distance between two colours in the given vision, 0 meaning identical. */
function separation(a: string, b: string, kind?: 'deuteranopia' | 'protanopia'): number {
	const read = (hex: string): [number, number, number] => kind
		? simulate(hex, kind)
		: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
	const [ar, ag, ab] = read(a)
	const [br, bg, bb] = read(b)
	return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2)
}

const KEYS = Object.keys(SERIES) as SeriesKey[]
const pairs = KEYS.flatMap((a, i) => KEYS.slice(i + 1).map((b) => [a, b] as const))

/**
 * The two GA4 series are the one deliberate near-collision: same instrument, same warm family, and
 * separated a second way by the dash pattern the chart already draws. Every other pair has colour
 * as its only separator and must survive on colour alone.
 */
const SAME_FAMILY = new Set(['ga4Pageviews|ga4Sessions'])

describe('the palette works on both Studio themes', () => {
	for (const key of KEYS) {
		it(`${key} clears 3:1 on the light card and the dark one`, () => {
			// 3:1 is the WCAG floor for a graphical object. A palette tuned on one theme reliably
			// disappears on the other, and the component is never told which it is in.
			expect(contrast(SERIES[key], GROUNDS.light)).toBeGreaterThanOrEqual(3)
			expect(contrast(SERIES[key], GROUNDS.dark)).toBeGreaterThanOrEqual(3)
		})
	}

	it('computes contrast the way the spec does', () => {
		// Anchored against known values, so the guard above cannot pass because the maths is wrong.
		expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
		expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
		expect(luminance('#ffffff')).toBeCloseTo(1, 5)
		expect(luminance('#000000')).toBeCloseTo(0, 5)
	})
})

describe('the palette separates its series', () => {
	for (const [a, b] of pairs) {
		const family = SAME_FAMILY.has(`${a}|${b}`)
		it(`${a} and ${b} are ${family ? 'a documented same-source pair' : 'distinguishable in normal vision'}`, () => {
			expect(separation(SERIES[a], SERIES[b])).toBeGreaterThan(family ? 0.1 : 0.35)
		})
	}

	for (const [a, b] of pairs.filter(([a, b]) => !SAME_FAMILY.has(`${a}|${b}`))) {
		it(`${a} and ${b} do not collapse for a deuteranope or a protanope`, () => {
			// About one man in twelve. A pair that has no second channel has to survive here.
			expect(separation(SERIES[a], SERIES[b], 'deuteranopia')).toBeGreaterThan(0.15)
			expect(separation(SERIES[a], SERIES[b], 'protanopia')).toBeGreaterThan(0.15)
		})
	}

	it('keeps the two GA4 series in the same warm family rather than scattering them', () => {
		// The near-collision is the design. If someone "fixes" it by pulling them apart, the palette
		// stops saying that these two lines come from one instrument.
		expect(separation(SERIES.ga4Pageviews, SERIES.ga4Sessions))
			.toBeLessThan(separation(SERIES.ga4Pageviews, SERIES.vercel))
	})
})

describe('seriesFill', () => {
	it('bakes the alpha into the colour rather than relying on fill-opacity', () => {
		expect(seriesFill('vercel', 0.2)).toBe('rgba(76, 143, 208, 0.2)')
	})

	it('defaults to the documented region alpha', () => {
		expect(seriesFill('orders')).toBe(seriesFill('orders', REGION_ALPHA))
	})

	it('stays well under the stroke, so a region never reads as a line', () => {
		expect(REGION_ALPHA).toBeLessThan(0.35)
	})
})
