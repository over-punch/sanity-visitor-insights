/**
 * A small in-memory TTL cache for report responses.
 *
 * Without this, every panel render and every range toggle is a live fan-out to GA4, Vercel and
 * Sanity. GA4's standard quota is finite per property per day and shared with anything else
 * querying it, so an editor idly switching ranges could exhaust it. Reports also change slowly —
 * GA4 does not finalise the last two days at all — so serving a few minutes stale costs nothing.
 *
 * Deliberately per-instance rather than a shared store: it is a quota guard and a latency
 * smoother, not a source of truth, and a cold serverless instance simply repopulates it.
 */

/** How long a cached report stays fresh. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

interface Entry<T> {
	value: T
	expiresAt: number
}

/** Bound the cache so a long-lived instance cannot grow without limit. */
const MAX_ENTRIES = 200

const store = new Map<string, Entry<unknown>>()

/** Build a stable cache key from the parts that determine a response. */
export function cacheKey(parts: Array<string | number | undefined>): string {
	return parts.map((p) => String(p ?? '')).join('|')
}

/**
 * Read a fresh cached value, or undefined when absent or stale.
 * Stale entries are evicted on read so expiry does not depend on a sweep.
 */
export function getCached<T>(key: string): T | undefined {
	const entry = store.get(key)
	if (!entry) return undefined

	if (entry.expiresAt <= Date.now()) {
		store.delete(key)
		return undefined
	}

	return entry.value as T
}

/** Store a value with a TTL, evicting the oldest entry when full. */
export function setCached<T>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
	if (store.size >= MAX_ENTRIES && !store.has(key)) {
		// Map preserves insertion order, so the first key is the oldest.
		const oldest = store.keys().next().value
		if (oldest !== undefined) store.delete(oldest)
	}

	store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

/**
 * Return a cached value or compute, cache and return it.
 * Concurrent callers may both compute on a cold key; that is acceptable here and avoids the
 * complexity of an in-flight promise registry for a cache this small.
 */
export async function withCache<T>(
	key: string,
	ttlMs: number,
	compute: () => Promise<T>,
	/**
	 * How long to keep this particular result.
	 *
	 * Given the computed value, so a caller can cache a healthy answer for the full window and a
	 * degraded one for seconds. A failure inside a report is caught and returned as an envelope full
	 * of `unavailable` — a normal return as far as this function is concerned — so a one-second GA4
	 * blip was stored as a success and blanked the panel for the whole TTL, with no refresh able to
	 * clear it because the key does not vary with the outcome. Five minutes of a real-looking outage
	 * from a transient one, on the tool whose subject is telling those apart.
	 */
	ttlFor?: (value: T) => number,
): Promise<T> {
	const hit = getCached<T>(key)
	if (hit !== undefined) return hit

	const value = await compute()
	const ttl = ttlFor ? ttlFor(value) : ttlMs
	if (ttl > 0) setCached(key, value, ttl)
	return value
}

/** Empty the cache. Test seam, and useful after a config change. */
export function clearCache(): void {
	store.clear()
}
