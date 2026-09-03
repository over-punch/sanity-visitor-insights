/**
 * Per-site adapter configuration.
 *
 * The three foundries differ in ways that cannot be abstracted away: different GA4 event coverage,
 * different order schemas, different flows that exist on one site and not another. Rather than
 * branching on a site id inside the reports — which would mean editing this package to onboard a
 * fourth foundry — each site describes itself through this config and the reports stay generic.
 */

import type { EventCutover } from './cutover'

/** GA4 connection for one site. */
export interface Ga4Config {
	/** Numeric GA4 property id. NOT the `G-XXXXXXX` measurement id, which is the client-side one. */
	propertyId: string
	/** IANA timezone the property is configured with. Every range is anchored to this. */
	timezone: string
	/**
	 * Hostnames belonging to this site. When set, every GA4 report is restricted to them.
	 *
	 * This exists because a GA4 property is not necessarily one website. Darden's property also
	 * receives `impactsport.ca`, an unrelated business, which contributed 68 of 389 sessions in a
	 * sample week — inside the headline session count, inside both percentages computed from it,
	 * and inside the funnel's entry rung. Without this, the tool silently reports two businesses
	 * added together and calls the total one site.
	 *
	 * Staging and legacy hosts belong here too, or are deliberately left out to exclude them.
	 * Omit entirely to accept every hostname, which is the old behaviour.
	 */
	hostnames?: readonly string[]
}

/** Vercel Web Analytics connection for one site. */
export interface VercelConfig {
	projectId: string
	teamId?: string
}

/** Where to count orders, and what they are called on this site. */
export interface OrdersConfig {
	/** Document type holding orders. */
	documentType: string
	/**
	 * Field holding the typeface references on an order, if the site has one.
	 * Null where orders do not resolve to typefaces in a usable way.
	 */
	typefacesField: string | null
	/**
	 * GROQ filter appended to exclude non-typeface orders, e.g. merch-only orders on Darden.
	 * Merch inflates a family's apparent purchase count if not excluded.
	 */
	excludeFilter?: string
	/**
	 * Field holding the order's status. Defaults to `orderStatus`.
	 *
	 * The status is always read and always reported as a breakdown, even when nothing is filtered
	 * on it — an operator cannot configure `countedStatuses` without first seeing what vocabulary
	 * their own orders actually use.
	 */
	statusField?: string
	/**
	 * Statuses that count as a real sale. Orders with any other status are excluded from every
	 * figure and reported separately as an excluded count.
	 *
	 * Omit to count every order regardless of status, which is the old behaviour and means test,
	 * failed, pending and refunded orders are all counted as sales. At seven orders a quarter one
	 * test order is a 14% error, so leaving this unset is rarely right once the vocabulary is known.
	 */
	countedStatuses?: readonly string[]
	/**
	 * Field holding the order's total, e.g. `total` or `amountPaid`. A number, in major units.
	 *
	 * Revenue was originally excluded from this package on the grounds that it reports behaviour
	 * and the sales portal reports sales. That was the wrong line: an order total is not a customer
	 * field, and without it a $30 web licence and a $400 multi-seat desktop licence are the same
	 * integer — so nothing in the tool can be ranked by what it is worth. The PII rule is unchanged
	 * and still enforced by the projection allow-list; only the value crosses over.
	 */
	totalField?: string
	/** ISO 4217 code for `totalField`, e.g. `USD`. Used for formatting only. */
	currency?: string
}

/**
 * Which of this site's events carry a given meaning.
 *
 * Sites do not converge on one name. TDF already emits five distinct type-tester events
 * (`variable_font_change`, `variable_style_change`, `style_change`, `feature_change`,
 * `opentype_feature`) and has done for a long time; inventing a `tester_engaged` for it would
 * discard that history and measure the same thing twice. Each entry is a list, and the counts are
 * summed, so a site can map several of its own events onto one concept.
 */
export interface EventNameMap {
	/** Events that count as genuine type-tester engagement — a change from the default state. */
	tester?: string[]
	/** Events fired when a visitor grants analytics consent. */
	consent?: string[]
	/**
	 * Events fired when a visitor submits a custom-typeface or licensing enquiry.
	 *
	 * A commission is worth many multiples of a licence, so an enquiry is the most valuable action
	 * on these sites. Darden has fired `enquiry_submit` throughout and no report read it, which
	 * meant the tool gave the $30 path six funnel rungs and the four-figure path none — and scored
	 * the enquiry-led visitor as a drop-off.
	 */
	enquiry?: string[]
	/** Events fired when a visitor joins the mailing list — the only audience a foundry owns. */
	subscribe?: string[]
	/** Events fired when a visitor downloads a trial font or a specimen PDF. */
	assetDownload?: string[]
}

/** One site's complete description of itself. */
export interface SiteAnalyticsConfig {
	/** Stable machine id, e.g. `darden`. */
	siteId: string
	/** Human label shown in the Studio UI. */
	label: string
	/** Null when GA4 is not wired up for this site — reports degrade rather than fail. */
	ga4: Ga4Config | null
	/** Null when Vercel Web Analytics is unavailable, e.g. on a plan tier without API access. */
	vercel: VercelConfig | null
	orders: OrdersConfig
	/**
	 * When each GA4 event began firing here. Events absent from this map report as `unknown_event`,
	 * which is the honest answer for a flow the site does not have — distinct from `not_instrumented`,
	 * which implies it is merely pending.
	 */
	eventCutovers: Record<string, EventCutover>
	/**
	 * This site's own names for the events the reports look for. Omit to use the defaults.
	 * Names listed here must also appear in `eventCutovers`, or they report as unknown events.
	 */
	eventNames?: EventNameMap
	/**
	 * Known measurement quirks for this site, shown with every report.
	 *
	 * Some differences between sites are semantic and cannot be normalised away — MCKL and TDF fire
	 * `add_to_cart` on every selection change rather than on a discrete cart action, so their cart
	 * step counts a different act from a site that fires it once. Stating that beside the figure is
	 * the only honest option; silently comparing them is not.
	 */
	caveats?: string[]
	/**
	 * Extra referrer hosts that count as design-industry coverage for this site.
	 *
	 * The package ships a short default list, which is necessarily generic and goes stale. A
	 * foundry's own press — a particular newsletter, a studio blog, a regional design publication —
	 * cannot be in it, and the resulting figure was being read as a verdict on the design press
	 * rather than as the coverage of a hard-coded list. Entries here are added to the defaults.
	 */
	designIndustrySources?: readonly string[]

	/**
	 * Studio roles allowed to read these reports, enforced server-side.
	 *
	 * Must match the `roles` given to the plugin, which only controls whether the tab is shown.
	 * Omit to allow any authenticated Studio user of this project. These panels expose order-derived
	 * conversion figures, so gating to administrators is usually right — and unlike the plugin
	 * option, setting it here actually prevents a direct call to the API route.
	 */
	roles?: readonly string[]
	/** Origins allowed to call this site's handler cross-origin, e.g. a separately deployed Studio. */
	allowedStudioOrigins?: string[]
}

/** A problem found while validating a site config. */
export interface ConfigProblem {
	field: string
	message: string
}

/**
 * Validate a site config at runtime.
 *
 * Compile-time types do not survive into a consuming site's `sanity.config.js`, which is plain
 * JavaScript — so a typo'd property id or a measurement id pasted where a numeric property id
 * belongs would otherwise surface as an empty chart rather than an error.
 *
 * @param config - the candidate config
 * @returns the problems found; an empty array means the config is usable
 */
export function validateSiteConfig(config: Partial<SiteAnalyticsConfig> | undefined): ConfigProblem[] {
	const problems: ConfigProblem[] = []

	if (!config) {
		return [{ field: 'config', message: 'No site config supplied' }]
	}

	if (!config.siteId) problems.push({ field: 'siteId', message: 'Required' })
	if (!config.label) problems.push({ field: 'label', message: 'Required' })

	if (config.ga4) {
		const { propertyId, timezone } = config.ga4
		if (!propertyId) {
			problems.push({ field: 'ga4.propertyId', message: 'Required when ga4 is configured' })
		} else if (propertyId.startsWith('G-')) {
			problems.push({
				field: 'ga4.propertyId',
				message: `Looks like a measurement id ("${propertyId}"). The Data API needs the numeric property id from GA4 Admin instead.`,
			})
		} else if (!/^\d+$/.test(propertyId)) {
			problems.push({ field: 'ga4.propertyId', message: 'Must be the numeric GA4 property id' })
		}

		if (!timezone) {
			problems.push({ field: 'ga4.timezone', message: 'Required — ranges are anchored to it' })
		} else if (!isValidTimeZone(timezone)) {
			problems.push({ field: 'ga4.timezone', message: `Not a recognised IANA timezone: ${timezone}` })
		}
	}

	for (const host of config.ga4?.hostnames ?? []) {
		// A scheme or a path here would silently match nothing: GA4's hostName dimension is the
		// bare host. Catching it at construction beats an empty dashboard.
		if (/^https?:\/\//.test(host) || host.includes('/')) {
			problems.push({ field: 'ga4.hostnames', message: `Must be a bare hostname, not a URL: ${host}` })
		}
	}

	if (config.orders?.countedStatuses && config.orders.countedStatuses.length === 0) {
		problems.push({
			field: 'orders.countedStatuses',
			message: 'Empty array would exclude every order. Omit the field to count all statuses.',
		})
	}

	if (config.vercel && !config.vercel.projectId) {
		problems.push({ field: 'vercel.projectId', message: 'Required when vercel is configured' })
	}

	if (!config.orders?.documentType) {
		problems.push({ field: 'orders.documentType', message: 'Required' })
	}

	if (!config.eventCutovers) {
		problems.push({ field: 'eventCutovers', message: 'Required — omit events the site does not have' })
	}

	for (const origin of config.allowedStudioOrigins ?? []) {
		if (!/^https?:\/\//.test(origin)) {
			problems.push({ field: 'allowedStudioOrigins', message: `Must be a full origin including scheme: ${origin}` })
		}
		if (origin.endsWith('/')) {
			problems.push({ field: 'allowedStudioOrigins', message: `Must not have a trailing slash: ${origin}` })
		}
	}

	return problems
}

/** Whether a string is an IANA timezone this runtime recognises. */
export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone })
		return true
	} catch {
		return false
	}
}

/** Throw if a config is unusable, naming every problem at once rather than one per run. */
export function assertValidSiteConfig(config: Partial<SiteAnalyticsConfig> | undefined): asserts config is SiteAnalyticsConfig {
	const problems = validateSiteConfig(config)
	if (problems.length > 0) {
		const detail = problems.map((p) => `  ${p.field}: ${p.message}`).join('\n')
		throw new Error(`Invalid visitor-insights site config:\n${detail}`)
	}
}
