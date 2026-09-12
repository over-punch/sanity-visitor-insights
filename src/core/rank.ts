/**
 * Where the latest week sits among the weeks before it.
 *
 * A percentage change is the wrong summary at a foundry's volumes. Seven orders against four is
 * "+75%", which is the largest type on the default tab and moves twenty-five points if one more
 * person buys. The tool's own report builders refuse far better-supported claims than that.
 *
 * A RANK does not have the problem. It makes no claim about magnitude, it is stable under the
 * one-order wobble that makes the ratio useless, and it answers the question a foundry owner
 * actually opens the panel with — was this week normal? — in a form that needs no arithmetic.
 *
 * It is computed from the exact daily series the envelope already carries, so it costs no request
 * and inherits none of GA4's loss: orders and revenue come from the foundry's own records.
 */

/** One day of a quantity. `null` means the day was not measured, which is not the same as zero. */
export interface DailyValue {
	date: string
	value: number | null
}

/** Where the most recent week landed among the weeks available to compare it with. */
export interface WeeklyRank {
	/** 1 is the best week in the window. */
	rank: number
	/** How many whole weeks were compared, including this one. */
	of: number
	/** The most recent week's total. */
	value: number
}

/**
 * How many whole weeks must be available before a rank is worth stating.
 *
 * Four. "Second of three" is barely a ranking and reads as more certain than it is; at four the
 * statement starts to carry information about what normal looks like. A Month range yields exactly
 * four, so the default view can say something; a Quarter yields thirteen.
 */
export const MIN_WEEKS_TO_RANK = 4

/**
 * Rank the most recent whole week against the whole weeks preceding it.
 *
 * Buckets backwards from the END of the series, so the latest week is always complete rather than
 * whatever fragment the calendar left. A week containing ANY unmeasured day is dropped rather than
 * summed — a partial week would compete as though it were a quiet one, which is the absent-versus-
 * zero error this package exists to avoid, wearing a different hat.
 *
 * Returns null when fewer than `MIN_WEEKS_TO_RANK` whole weeks survive that rule.
 *
 * @param series - daily values in ascending date order
 */
export function weeklyRank(series: readonly DailyValue[]): WeeklyRank | null {
	if (series.length < 7 * MIN_WEEKS_TO_RANK) return null

	// Backwards from the end: the most recent seven days are the week being ranked.
	const weeks: Array<number | null> = []
	for (let end = series.length; end - 7 >= 0; end -= 7) {
		const slice = series.slice(end - 7, end)
		// All seven days measured, or the week does not compete.
		weeks.push(slice.some((d) => d.value === null) ? null : slice.reduce((sum, d) => sum + (d.value as number), 0))
	}

	const latest = weeks[0]
	if (latest === null || latest === undefined) return null

	const comparable = weeks.filter((w): w is number => w !== null)
	if (comparable.length < MIN_WEEKS_TO_RANK) return null

	// Ties share the better rank: two equal-best weeks are both "1st", which is what a reader
	// means by best. Counting strictly-greater weeks gives that for free.
	const better = comparable.filter((w) => w > latest).length

	return { rank: better + 1, of: comparable.length, value: latest }
}

/**
 * The rank as a reader would say it.
 *
 * Deliberately plain: no "percentile", no "quartile". "Best of the last 13 weeks" is a sentence a
 * foundry owner can forward to a business partner without translating it first.
 *
 * @param rank - the result of weeklyRank
 */
export function describeRank(rank: WeeklyRank): string {
	const ordinal = (n: number): string => {
		const tens = n % 100
		if (tens >= 11 && tens <= 13) return `${n}th`
		return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
	}
	if (rank.rank === 1) return `best of the last ${rank.of} weeks`
	if (rank.rank === rank.of) return `lowest of the last ${rank.of} weeks`
	return `${ordinal(rank.rank)} best of the last ${rank.of} weeks`
}
