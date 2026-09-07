/**
 * How much of reality GA4 is seeing, measured against sources that are not lossy.
 *
 * GA4 is the only source here that misses things: consent refusal, ad-blocking, a tag that stops
 * firing, a data filter switched to Active. On Darden it has been reporting roughly a fifth of the
 * pageviews Vercel counts. Every panel built on it is therefore an undercount of unknown size, and
 * the tool's answer to that has been a caveat — accurate, and useless for deciding anything.
 *
 * The other sources overlap GA4 in places where both measure the same thing, and each of those
 * overlaps yields an independent estimate of the same quantity: GA4's capture rate. That is what
 * makes them worth combining. One ratio is a curiosity; three that agree are a measurement, and
 * three that disagree localise the fault.
 *
 * The estimates are deliberately NOT averaged into a single number. They measure different
 * populations and fail in different ways, and their disagreement carries more information than
 * their mean — so the model keeps them separate, picks the most trustworthy as the point estimate,
 * and uses the spread as the interval.
 */

/** Where one estimate of the capture rate came from. */
export type CaptureBasis = 'orders' | 'pageviews' | 'email'

/** One independent estimate of GA4's capture rate. */
export interface CaptureEstimate {
	basis: CaptureBasis
	/** Fraction of reality GA4 saw, by this measure. Above 1 means GA4 counted more, not less. */
	rate: number
	/** What GA4 reported. */
	observed: number
	/** What the non-lossy source reported for the same thing. */
	actual: number
	/** How much weight this estimate deserves, and why, in words a panel can show. */
	note: string
}

/**
 * How far apart two estimates must be before the disagreement is worth reporting.
 *
 * A fifth. Below that, the ratios differ for ordinary reasons — a crawler Vercel counted, an order
 * placed either side of midnight — and calling it a discrepancy would cry wolf on every load.
 */
const DISAGREEMENT_THRESHOLD = 0.2

/**
 * The minimum denominator an estimate needs to mean anything.
 *
 * At seven orders a quarter, one order either way moves the orders-based rate by fourteen points.
 * Below this the ratio is noise wearing a decimal point, so it is excluded rather than shown with
 * a caveat nobody reads.
 */
const MIN_DENOMINATOR = 5

/**
 * Build the orders-based estimate — the most trustworthy of the three.
 *
 * It compares GA4's `purchase` count against the orders that actually exist in Sanity. Same event,
 * same population, and the denominator is exact rather than merely better. Its weakness is size:
 * these foundries do single-digit orders a week, so it needs a long enough range to escape noise.
 */
export function fromOrders(ga4Purchases: number, sanityOrders: number): CaptureEstimate | null {
	if (sanityOrders < MIN_DENOMINATOR) return null

	// The sensitivity is on the SCREEN, not only in a comment four lines above the threshold. The
	// note used to end "the denominator is exact" — true of the order count and badly misleading
	// about the rate, which at seven orders moves fourteen points if one order lands either side of
	// midnight. This is the most trusted estimate, so it is the one that grosses up every corrected
	// figure in the tool; the reader is entitled to know how thin it is.
	/*
	 * The NUMERATOR's sensitivity, which is the fragile side.
	 *
	 * This printed `1 / sanityOrders` and described it as the effect of "one more or fewer order" —
	 * quoting the denominator's sensitivity and stating it wrongly. For a rate of k/n, one more
	 * ORDER moves it by rate/n, which at a 20% capture and seven orders is about three points, not
	 * fourteen. One more GA4 PURCHASE moves it by 1/n, which is the fourteen — and that is the side
	 * that actually wobbles, because the numerator is the lossy one. The single caveat the reader
	 * is given about the tool's most load-bearing ratio pointed at the steady half.
	 */
	const swing = Math.round((1 / sanityOrders) * 100)
	return {
		basis: 'orders',
		rate: ga4Purchases / sanityOrders,
		observed: ga4Purchases,
		actual: sanityOrders,
		note: `GA4 purchases against the ${sanityOrders} orders that exist — the same event on both sides. `
			+ `Small numbers move it a long way: one more or fewer purchase seen by GA4 shifts this rate by about ${swing} points.`,
	}
}

/**
 * Build the pageview-based estimate.
 *
 * An UPPER bound on the capture rate, not a lower one. This comment said the opposite for the life
 * of the package, on the strength of a claim about Vercel that is not true.
 *
 * Vercel Web Analytics is not server-side. It is the `@vercel/analytics` client script — the same
 * kind of beacon GA4 uses, on a first-party path — so it is blocked too, just by fewer lists, and
 * it does not run for crawlers at all. The old reasoning was: Vercel over-counts (crawlers), so the
 * ratio understates GA4's true capture, so treat it as a floor. Both halves are wrong. Vercel is
 * itself an undercount of reality, so the real denominator is LARGER than the one used here, and
 * GA4/Vercel therefore flatters GA4 rather than maligning it.
 *
 * Which way this matters: when this estimate says GA4 sees a fifth of the traffic, the truth is a
 * fifth or less — never more. The direction of the caveat printed beside it was reversed.
 */
export function fromPageviews(ga4Pageviews: number, vercelPageviews: number): CaptureEstimate | null {
	if (vercelPageviews < MIN_DENOMINATOR) return null
	return {
		basis: 'pageviews',
		rate: ga4Pageviews / vercelPageviews,
		observed: ga4Pageviews,
		actual: vercelPageviews,
		note: 'GA4 pageviews against Vercel’s. Read it as a ceiling: Vercel’s own counter is a script too — blocked by fewer lists than GA4, but blocked — so real traffic is higher than both and GA4’s true share is this or less.',
	}
}

/**
 * Build the email-based estimate.
 *
 * A known-size cohort: Mailchimp knows exactly how many people clicked through, and GA4 should see
 * a session for each. It measures the capture rate on traffic that is tagged and arriving from a
 * single known source, so a shortfall here that the others do not show points at attribution — a
 * tagging or redirect problem — rather than at measurement generally.
 */
export function fromEmail(ga4Users: number, mailchimpClicks: number): CaptureEstimate | null {
	if (mailchimpClicks < MIN_DENOMINATOR) return null
	return {
		basis: 'email',
		rate: ga4Users / mailchimpClicks,
		observed: ga4Users,
		actual: mailchimpClicks,
		note: 'Distinct people GA4 saw arriving from email, against the distinct subscribers Mailchimp says clicked. Both sides count people, so the comparison holds — but it measures tagging as much as capture.',
	}
}

/**
 * A rough interval for a single rate, from how few events it was measured on.
 *
 * Two standard errors of a binomial proportion, clamped to the unit interval. At one GA4 purchase
 * against seven orders the honest range is enormous, and printing that is the point: the figure is
 * doing real work — it grosses up every corrected number in the tool — on a handful of events.
 *
 * @param estimate - the single estimate the model has
 */
function samplingInterval(estimate: CaptureEstimate): { low: number; high: number } {
	const n = estimate.actual
	if (!Number.isFinite(n) || n <= 0) return { low: estimate.rate, high: estimate.rate }
	/*
	 * The interval is built around the RATE, not around a clamped copy of it.
	 *
	 * `p` was clamped to 0..1 for the variance — correct, a proportion's variance is only defined
	 * there — and then the bounds were clamped to 0..1 as well. A rate above 1 is explicitly
	 * supported here ("above 1 means GA4 counted more, not less"), so a 140% capture rate came back
	 * with a range of 91% to 100%: a point estimate outside its own interval, printed as such.
	 *
	 * The variance still uses the clamped proportion; only the bounds follow the rate.
	 */
	const p = Math.min(1, Math.max(0, estimate.rate))
	const error = 2 * Math.sqrt(Math.max(p * (1 - p), 0.02) / n)
	return { low: Math.max(0, estimate.rate - error), high: estimate.rate + error }
}

/** The combined view of GA4's capture rate. */
export interface CaptureModel {
	/** Every estimate that had a usable denominator, best first. */
	estimates: CaptureEstimate[]
	/** The rate to gross up by, or null when nothing was measurable. */
	rate: number | null
	/** The plausible range for that rate. Equal to `rate` when only one estimate exists. */
	low: number | null
	high: number | null
	/**
	 * What the disagreement between estimates implies, or null when they agree or only one exists.
	 * This is the output worth reading when it is present: it says WHERE the problem is.
	 */
	discrepancy: string | null
}

/** Order of trust. Orders beat pageviews because they compare the same event on both sides. */
const TRUST: CaptureBasis[] = ['orders', 'email', 'pageviews']

/**
 * Combine whatever estimates were measurable.
 *
 * @param candidates - the estimates, any of which may be null when its denominator was too small
 */
export function captureModel(candidates: Array<CaptureEstimate | null>): CaptureModel {
	const estimates = candidates
		.filter((e): e is CaptureEstimate => e !== null)
		.sort((a, b) => TRUST.indexOf(a.basis) - TRUST.indexOf(b.basis))

	if (estimates.length === 0) {
		return { estimates, rate: null, low: null, high: null, discrepancy: null }
	}

	const rates = estimates.map((e) => e.rate)
	// The point estimate is the most trusted single measurement, NOT the mean. Averaging a
	// same-event ratio against a not-like-for-like one produces a number that is neither, and the
	// pageview ratio would drag it down for reasons that are definitional rather than real.
	const rate = estimates[0]!.rate
	/*
	 * A single estimate gets a SAMPLING interval, not a zero-width one.
	 *
	 * `low` and `high` were the min and max across estimates, so with one estimate they both equal
	 * the point — and the panel rendered "~2,499" with the subtitle "2,499 to 2,499" and an
	 * Estimated badge. A zero-width interval on the one quantity this package exists to call
	 * uncertain. On a Week range only the pageview estimate clears its denominator, so that was the
	 * ordinary case rather than an edge one.
	 *
	 * The interval here is the normal approximation to a binomial proportion — the observed count
	 * out of the true one — which is the actual reason this number is uncertain at these volumes.
	 * It is deliberately not exact: the point is to stop printing a false precision, not to claim a
	 * different one.
	 */
	const spread = estimates.length > 1
		? { low: Math.min(...rates), high: Math.max(...rates) }
		: samplingInterval(estimates[0]!)

	return { estimates, rate, low: spread.low, high: spread.high, discrepancy: describeDisagreement(estimates) }
}

/**
 * Say what a disagreement between estimates means.
 *
 * Each pairing fails in a characteristic way, and naming the pattern is the whole value of holding
 * three estimates rather than one — it turns "something is wrong" into "this specific thing is
 * wrong", which is the difference between a caveat and an instruction.
 */
function describeDisagreement(estimates: CaptureEstimate[]): string | null {
	if (estimates.length < 2) return null

	const by = (basis: CaptureBasis) => estimates.find((e) => e.basis === basis)
	const orders = by('orders')
	const pageviews = by('pageviews')
	const email = by('email')

	if (orders && pageviews && Math.abs(orders.rate - pageviews.rate) > DISAGREEMENT_THRESHOLD) {
		return orders.rate > pageviews.rate
			? 'GA4 is capturing purchases far better than pageviews. That points at the pageview comparison rather than at a measurement failure — Vercel counts crawlers and prefetches GA4 never sees. Conversion figures here are more trustworthy than traffic figures.'
			: 'GA4 is capturing pageviews but missing purchases. That is not consent or ad-blocking, which would cost both equally — look at the purchase event itself: whether it fires on a page some buyers never reach, or is blocked at checkout.'
	}

	// The everyday pair. At seven orders a quarter the orders estimate is below its minimum on Week
	// and Month, so email-against-pageviews is usually the only comparison there is — and it was the
	// one pairing with no diagnosis at all, returning null and telling the reader nothing while two
	// contradictory percentages sat side by side under "How much GA4 is seeing".
	if (email && pageviews && Math.abs(email.rate - pageviews.rate) > DISAGREEMENT_THRESHOLD) {
		return email.rate < pageviews.rate
			? 'Far fewer people are arriving from your mailing list than GA4’s general capture would predict. That points at the campaign links rather than at measurement — check they carry UTM tags, and that no redirect is stripping them.'
			: 'Email traffic is over-represented against GA4’s general capture rate, which usually means campaign links are tagged while ordinary traffic is not — so email looks larger than it is.'
	}

	if (email && orders && Math.abs(email.rate - orders.rate) > DISAGREEMENT_THRESHOLD) {
		return email.rate < orders.rate
			? 'Traffic from email is arriving less often than GA4’s general capture rate would predict. That is an attribution problem rather than a measurement one — check the campaign links for missing UTMs, or a redirect stripping them.'
			: 'Email traffic is over-represented against GA4’s general capture rate, which usually means campaign links are tagged while ordinary traffic is not, so email looks larger than it is.'
	}

	return null
}

/**
 * Gross a GA4 count up to an estimated true value.
 *
 * Returns null when there is no usable rate, so the caller reports the raw count rather than
 * inventing one — an estimate with no basis is worse than an honest undercount.
 *
 * @param observed - what GA4 counted
 * @param model - the capture model for the same range
 */
export function grossUp(
	observed: number,
	model: CaptureModel,
	/**
	 * Which bases may be used. Defaults to every one, which is right only when the quantity being
	 * grossed up is the same kind of thing the estimate measured.
	 */
	admissible: CaptureBasis[] = ['orders', 'email', 'pageviews'],
): { value: number; low: number; high: number; basis: CaptureBasis; rate: number } | null {
	/*
	 * The estimate has to measure the same kind of loss as the quantity being corrected.
	 *
	 * Sessions were grossed up by `model.rate`, which is the most trusted estimate — the ORDERS one
	 * whenever it exists. That is purchase-event capture, and this file argues at length that
	 * purchase capture and traffic capture fail independently: a checkout on a third-party domain, a
	 * purchase event without a value, a consent banner that gates one and not the other. So a broken
	 * purchase tag was laundered into a multiplier on the traffic figure, under a heading reading
	 * "Sessions, corrected for what GA4 misses".
	 */
	/*
	 * The best USABLE estimate, not merely the first.
	 *
	 * `usable[0]` is the most trusted admissible basis, and email outranks pageviews — so a campaign
	 * whose links carry no UTM produced a rate of 0, which fails the checks below, and the panel
	 * reported "no traffic-based capture estimate for this range" while the pageview estimate sat two
	 * cards above it saying twenty per cent. A partially tagged campaign was worse: it governed the
	 * correction outright and quadrupled the corrected figure against what the site-wide comparison
	 * said.
	 *
	 * Trust order still decides between estimates that can each carry the correction; it must not
	 * hand it to one that cannot.
	 */
	const usable = model.estimates.filter((e) => (
		admissible.includes(e.basis) && e.rate > 0 && e.rate < 1 && Number.isFinite(e.rate)
	))
	if (usable.length === 0) return null
	const rate = usable[0]!.rate
	const rates = usable.map((e) => e.rate)
	// The interval is rebuilt from the ADMISSIBLE estimates only.
	//
	// It fell through to the model's own low/high when filtering left one estimate — and those are
	// the min and max across EVERY estimate, including the ones just excluded. So a traffic figure
	// was given a lower bound derived entirely from the orders rate: exactly the purchase-tag
	// capture this filter exists to keep out, arriving through the back door and printed as the
	// bottom of the range. It also bypassed the lone-estimate sampling interval in precisely the
	// case the filter creates.
	const bounds = usable.length > 1
		? { low: Math.min(...rates), high: Math.max(...rates) }
		: samplingInterval(usable[0]!)
	model = { ...model, rate, low: bounds.low, high: bounds.high }

	if (model.rate === null || model.rate <= 0 || model.low === null || model.high === null) return null
	if (model.high <= 0) return null

	// A rate at or above 1 means GA4 is not undercounting on this measure, so there is nothing to
	// gross up and pretending otherwise would inflate a figure that is already complete.
	if (model.rate >= 1) return null

	/*
	 * The interval inverts: the LOW capture rate produces the HIGH estimate of reality.
	 *
	 * A low bound of zero means the upper end is unbounded, and that used to discard the whole
	 * figure — `if (model.low <= 0) return null`. The sampling interval reaches zero whenever the
	 * rate is at or under roughly 4/(n+4), which at a fifth capture and single-digit orders is the
	 * archetypal case for these foundries, so the correction vanished exactly where it was wanted.
	 * Worse, the caller then reported "not enough overlap between sources to estimate a true
	 * figure", which was false: there was overlap and a usable point estimate, and only the upper
	 * bound was unbounded.
	 *
	 * The guard belonged to a different failure — a missing rate — and was catching a legitimately
	 * wide interval instead. A floored bound keeps the point and states an upper end that is
	 * honestly enormous rather than pretending there is none.
	 */
	const floor = Math.max(model.low, 0.01)
	const low = observed / Math.min(1, model.high)
	const high = observed / floor
	// Ordered, because the two clamps can cross. `Math.min(1, high)` and `Math.max(low, 0.01)` pass
	// each other whenever the capture rate is under about 1% — which is not an exotic case, it is a
	// dead tag, the exact failure this package was built for. The panel renders these verbatim, so
	// it printed "~10,000" over "1,502 to 500" with an Estimated badge.
	return {
		value: observed / model.rate,
		low: Math.min(low, high),
		high: Math.max(low, high),
		// The estimate this figure was ACTUALLY built from. Callers described it using the model's
		// own rate and first basis, which after filtering is a different estimate — so the caption
		// read "seeing 14% of activity, measured against the orders that exist" beside a number
		// derived from the pageview rate of 20%. 1000/0.14 is 7,000, not the 5,000 printed. The
		// exclusion was fixed in the arithmetic and left broken in the label.
		basis: usable[0]!.basis,
		rate,
	}
}
