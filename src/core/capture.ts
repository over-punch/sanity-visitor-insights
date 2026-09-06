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
	const swing = Math.round((1 / sanityOrders) * 100)
	return {
		basis: 'orders',
		rate: ga4Purchases / sanityOrders,
		observed: ga4Purchases,
		actual: sanityOrders,
		note: `GA4 purchases against the ${sanityOrders} orders that exist — the same event on both sides. `
			+ `Small numbers move it a long way: one more or fewer order shifts this rate by about ${swing} points.`,
	}
}

/**
 * Build the pageview-based estimate.
 *
 * Treat it as a LOWER bound on the capture rate rather than a measurement. Vercel counts
 * server-side, so it also counts crawlers, prefetches and route changes GA4 never sees — which
 * inflates the apparent loss. A gap here that the orders estimate does not corroborate is more
 * likely definitional than a real failure.
 */
export function fromPageviews(ga4Pageviews: number, vercelPageviews: number): CaptureEstimate | null {
	if (vercelPageviews < MIN_DENOMINATOR) return null
	return {
		basis: 'pageviews',
		rate: ga4Pageviews / vercelPageviews,
		observed: ga4Pageviews,
		actual: vercelPageviews,
		note: 'GA4 pageviews against Vercel’s. A lower bound: Vercel also counts crawlers and prefetches that GA4 never sees, so it overstates the loss.',
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
export function fromEmail(ga4Sessions: number, mailchimpClicks: number): CaptureEstimate | null {
	if (mailchimpClicks < MIN_DENOMINATOR) return null
	return {
		basis: 'email',
		rate: ga4Sessions / mailchimpClicks,
		observed: ga4Sessions,
		actual: mailchimpClicks,
		note: 'GA4 sessions from the campaign against Mailchimp’s unique clicks. A cohort whose true size is known exactly.',
	}
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
	const low = Math.min(...rates)
	const high = Math.max(...rates)

	return { estimates, rate, low, high, discrepancy: describeDisagreement(estimates) }
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
export function grossUp(observed: number, model: CaptureModel): { value: number; low: number; high: number } | null {
	if (model.rate === null || model.rate <= 0 || model.low === null || model.high === null) return null
	if (model.low <= 0 || model.high <= 0) return null

	// A rate at or above 1 means GA4 is not undercounting on this measure, so there is nothing to
	// gross up and pretending otherwise would inflate a figure that is already complete.
	if (model.rate >= 1) return null

	// The interval inverts: the LOW capture rate produces the HIGH estimate of reality.
	return {
		value: observed / model.rate,
		low: observed / Math.min(1, model.high),
		high: observed / model.low,
	}
}
