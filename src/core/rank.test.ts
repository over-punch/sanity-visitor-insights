/**
 * Tests for the weekly rank.
 *
 * The rank exists because a percentage is the wrong summary at seven orders a quarter. These
 * assert the two things that make it trustworthy: that a week with an unmeasured day never
 * competes, and that it refuses to rank at all when there is too little to rank against.
 */

import { describe, expect, it } from 'vitest'
import { MIN_WEEKS_TO_RANK, describeRank, weeklyRank, type DailyValue } from './rank'

/** A run of days, newest last, from a list of weekly totals spread evenly across each week. */
function weeks(totals: Array<number | null>): DailyValue[] {
	const out: DailyValue[] = []
	let day = 0
	for (const total of totals) {
		for (let i = 0; i < 7; i++) {
			out.push({
				date: `2026-01-${String(++day).padStart(2, '0')}`,
				value: total === null ? null : (i === 0 ? total : 0),
			})
		}
	}
	return out
}

describe('weeklyRank', () => {
	it('ranks the most recent week against the weeks before it', () => {
		// Oldest first: 3, 9, 5, then the latest at 7. One week beat it.
		expect(weeklyRank(weeks([3, 9, 5, 7]))).toEqual({ rank: 2, of: 4, value: 7 })
	})

	it('calls the best week first', () => {
		expect(weeklyRank(weeks([3, 4, 5, 9]))?.rank).toBe(1)
	})

	it('gives tied weeks the better rank, which is what "best" means to a reader', () => {
		expect(weeklyRank(weeks([9, 4, 5, 9]))?.rank).toBe(1)
	})

	it('drops a week containing an unmeasured day rather than summing it as a quiet one', () => {
		// The absent-versus-zero rule, in a different hat. A half-measured week would compete as a
		// bad week and make the latest look better than it was.
		//
		// Five weeks, so that dropping one still leaves enough to rank against — with four, losing
		// one correctly refuses entirely, which is a different behaviour and tested below.
		const series = weeks([3, 9, 5, 2, 7])
		series[8] = { date: series[8]!.date, value: null }
		const ranked = weeklyRank(series)
		expect(ranked?.of).toBe(4)
		// And the dropped week was the 9 — the best one — so the latest must NOT inherit its rank.
		expect(ranked?.rank).toBe(1)
	})

	it('refuses when dropping an unmeasured week leaves too few to compare', () => {
		const series = weeks([3, 9, 5, 7])
		series[8] = { date: series[8]!.date, value: null }
		expect(weeklyRank(series)).toBeNull()
	})

	it('refuses to rank when too few whole weeks survive', () => {
		// "Second of three" reads as more certain than it is.
		expect(weeklyRank(weeks([3, 9, 5]))).toBeNull()
	})

	it('refuses when the latest week itself is not fully measured', () => {
		// Ranking a partial week against whole ones compares different things.
		const series = weeks([3, 9, 5, 7])
		series[series.length - 1] = { date: series[series.length - 1]!.date, value: null }
		expect(weeklyRank(series)).toBeNull()
	})

	it('needs at least four weeks of days before it will look', () => {
		expect(weeklyRank(weeks([5, 5, 5]))).toBeNull()
		expect(weeklyRank(weeks([5, 5, 5, 5]))).not.toBeNull()
		expect(MIN_WEEKS_TO_RANK).toBe(4)
	})

	it('buckets from the END, so the ranked week is whole rather than a calendar fragment', () => {
		// 30 days: four whole weeks from the end, and two orphan days at the start that must not
		// become a fifth, tiny, unbeatable week.
		const series = [...weeks([1, 1, 1, 1])]
		series.unshift({ date: '2025-12-30', value: 99 }, { date: '2025-12-31', value: 99 })
		expect(weeklyRank(series)?.of).toBe(4)
	})
})

describe('describeRank', () => {
	it('says it the way a reader would', () => {
		expect(describeRank({ rank: 1, of: 13, value: 9 })).toBe('best of the last 13 weeks')
		expect(describeRank({ rank: 13, of: 13, value: 0 })).toBe('lowest of the last 13 weeks')
		expect(describeRank({ rank: 4, of: 13, value: 7 })).toBe('4th best of the last 13 weeks')
	})

	it('gets the awkward ordinals right', () => {
		expect(describeRank({ rank: 2, of: 9, value: 1 })).toContain('2nd')
		expect(describeRank({ rank: 3, of: 9, value: 1 })).toContain('3rd')
		expect(describeRank({ rank: 11, of: 20, value: 1 })).toContain('11th')
		expect(describeRank({ rank: 12, of: 20, value: 1 })).toContain('12th')
		expect(describeRank({ rank: 13, of: 20, value: 1 })).toContain('13th')
		expect(describeRank({ rank: 21, of: 30, value: 1 })).toContain('21st')
	})
})
