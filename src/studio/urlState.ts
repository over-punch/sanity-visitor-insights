/**
 * The tool's view, in the URL — so a finding can be sent to someone.
 *
 * Every piece of state here was component-local: tab, range, and the custom window. A Studio
 * reload, a browser back, or an accidental navigation discarded the whole investigation, and
 * "Acquisition, 24 August to 7 September" — the exact view in which someone notices the thing worth
 * noticing — could not be handed to a colleague or returned to by the person who found it. There is
 * a "Copy as CSV" in this tool precisely because sharing a finding is the real task; the view
 * itself was the one thing that could not be shared.
 *
 * The HASH, not the path or the query. Sanity's own router owns the path, and writing to it would
 * fight the Studio for control of navigation; the hash is unclaimed, survives a reload, is carried
 * by a copied link, and is ignored by every server. The value is namespaced because other tools in
 * the same Studio may want the same trick.
 *
 * Everything here is a pure string transformation, so it is testable without a DOM — which matters,
 * because the alternative is a feature whose only proof is clicking around a deployed Studio.
 */

/** The part of the tool's state worth putting in a link. */
export interface ViewState {
	/** Tab id, e.g. `overview`. */
	tab?: string
	/** Range key, e.g. `week` or `custom`. */
	range?: string
	/** Custom window start, ISO date. Only meaningful when `range` is `custom`. */
	from?: string
	/** Custom window end, ISO date. */
	to?: string
}

/** Our namespace within the hash, so another tool's state is left alone. */
const KEY = 'insights'

/** An ISO calendar date, and nothing else — this value reaches a report request. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Identifiers we will echo back into the URL.
 *
 * Tab and range ids are matched against known lists by the caller, but this is the first gate: the
 * hash is attacker-controllable in the sense that anyone can send a link, so nothing shaped
 * unexpectedly gets as far as being compared, stored, or rendered.
 */
const IDENTIFIER = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Serialise a view to the hash fragment it should occupy.
 *
 * Returns an empty string for an empty view, so a default view leaves the URL clean rather than
 * decorating it with state nobody set.
 *
 * @param view - the state to encode
 */
export function encodeView(view: ViewState): string {
	const parts: string[] = []
	if (view.tab && IDENTIFIER.test(view.tab)) parts.push(`tab:${view.tab}`)
	if (view.range && IDENTIFIER.test(view.range)) parts.push(`range:${view.range}`)
	// The window is only carried when it is the one in use. A stale custom range riding along in
	// every link would reopen someone else's window when they clicked a link about the week.
	if (view.range === 'custom') {
		if (view.from && ISO_DATE.test(view.from)) parts.push(`from:${view.from}`)
		if (view.to && ISO_DATE.test(view.to)) parts.push(`to:${view.to}`)
	}
	return parts.length > 0 ? `${KEY}=${parts.join(';')}` : ''
}

/**
 * Read a view out of a hash fragment.
 *
 * Every field is validated and an unrecognised one is dropped rather than defaulted, so a truncated
 * or hand-edited link degrades to whatever it could parse instead of failing or, worse, silently
 * requesting a window nobody chose.
 *
 * @param hash - `window.location.hash`, with or without its leading `#`
 */
export function decodeView(hash: string): ViewState {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash
	// Other tools' fragments live alongside ours, separated by `&` as in a query string.
	const mine = raw.split('&').find((part) => part.startsWith(`${KEY}=`))
	if (!mine) return {}

	const view: ViewState = {}
	for (const pair of mine.slice(KEY.length + 1).split(';')) {
		const separator = pair.indexOf(':')
		if (separator < 1) continue
		const name = pair.slice(0, separator)
		const value = pair.slice(separator + 1)
		if (name === 'tab' && IDENTIFIER.test(value)) view.tab = value
		else if (name === 'range' && IDENTIFIER.test(value)) view.range = value
		else if (name === 'from' && ISO_DATE.test(value)) view.from = value
		else if (name === 'to' && ISO_DATE.test(value)) view.to = value
	}

	// A custom range needs both ends. One alone would resolve against a default the sender never
	// saw, which is a different window wearing the same link.
	if (view.range === 'custom' && !(view.from && view.to)) {
		delete view.from
		delete view.to
		delete view.range
	}

	return view
}

/**
 * Replace our fragment in a hash, preserving anyone else's.
 *
 * @param hash - the current hash
 * @param view - the state to write
 */
export function mergeIntoHash(hash: string, view: ViewState): string {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash
	const others = raw.split('&').filter((part) => part.length > 0 && !part.startsWith(`${KEY}=`))
	const mine = encodeView(view)
	const all = mine ? [...others, mine] : others
	return all.length > 0 ? `#${all.join('&')}` : ''
}
