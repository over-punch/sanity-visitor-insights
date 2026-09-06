/**
 * One bounded fetch, shared by every upstream this package talks to.
 *
 * None of the three clients had a timeout. A hung GA4, Vercel or Mailchimp connection held the
 * whole panel until the platform's function limit — 300 seconds on Vercel — and because the report
 * layer fans out with `Promise.all`, the slowest of up to fourteen concurrent calls set the floor
 * for all of them. The reader saw a spinner, not an error, for as long as that took.
 *
 * A timeout here surfaces as a normal rejection, which every caller already handles: the source is
 * marked unavailable with a reason, the other sources still answer, and the degraded envelope is
 * now cached for seconds rather than minutes. Slow becomes "did not respond", which is a thing the
 * panel can say.
 */

/**
 * How long any single upstream request may take.
 *
 * Twelve seconds. GA4's batch endpoint over a year of data is the slowest call this package makes
 * and returns comfortably inside that; beyond it, waiting is worse than reporting the source down,
 * because a Studio panel is read interactively and a reader who waits thirty seconds has already
 * concluded the tool is broken.
 */
export const REQUEST_TIMEOUT_MS = 12_000

/**
 * `fetch`, bounded.
 *
 * Composes with any signal the caller already passes, so a future cancellation path is not shut
 * out by this one. The timer is always cleared, including on rejection, so a long-lived server does
 * not accumulate handles.
 *
 * @param input - as `fetch`
 * @param init - as `fetch`; its `signal` is honoured alongside the timeout
 * @param timeoutMs - override for an upstream known to be slower
 */
export async function fetchWithTimeout(
	input: string,
	init: RequestInit = {},
	timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)

	// The caller's own signal still aborts us. Without this, passing a signal would silently stop
	// working the moment a timeout was added.
	const caller = init.signal
	const onCallerAbort = () => controller.abort()
	if (caller) {
		if (caller.aborted) controller.abort()
		else caller.addEventListener('abort', onCallerAbort, { once: true })
	}

	try {
		return await fetch(input, { ...init, signal: controller.signal })
	} catch (error) {
		// Named, so a timeout does not reach the panel as the browser's generic "The operation was
		// aborted", which reads like a bug in the tool rather than a slow upstream.
		if (controller.signal.aborted && !caller?.aborted) {
			throw new Error(`Request timed out after ${timeoutMs}ms`)
		}
		throw error
	} finally {
		clearTimeout(timer)
		caller?.removeEventListener('abort', onCallerAbort)
	}
}
