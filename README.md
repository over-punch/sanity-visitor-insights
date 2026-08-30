# @liiift-studio/sanity-visitor-insights

Visitor-**behaviour** analytics inside Sanity Studio, for Darden, TDF and MCKL.

This is not a sales tool and does not duplicate the sales portal. It reports what visitors do —
where they come from, how far they get, which typefaces they engage with — and reconciles GA4
against Vercel so you can see how much of that behaviour you are actually measuring. Orders appear
only as a conversion anchor and a count; no revenue, and no customer data.

---

## What it reports

| Panel | Question it answers |
|---|---|
| **Measurement health** | How much of reality does each source actually see? |
| **Acquisition** | Where do visitors come from, and how many are design-industry referrals? |
| **Journey** | How far do visitors get, and where do they stop? |
| **Typeface interest** | Which families get viewed, tested and bought? |
| **Diagnostics** | What to fix before trusting any of the above? |

Each panel offers a week, quarter or year range.

---

## Design decisions worth knowing

These are deliberate and load-bearing. Changing them changes whether the numbers are honest.

**Pageviews are compared to pageviews.** An earlier design subtracted Vercel pageviews from GA4
sessions and attributed the difference to consent, ad-blockers and bots. Sessions and pageviews are
different units, so that difference is dominated by the unit mismatch rather than by anything
missing — and GA4 exposes no signal separating those three causes anyway. The panel now compares
like with like and labels the remainder unexplained.

**Consent is measured, not inferred.** A `consent_granted` event turns the single largest cause of
the GA4/Vercel gap into a real number. Until a site instruments it, the panel says so instead of
guessing.

**Outages are recorded, not just start dates.** An event can exist in the code and still stop
reaching GA4 — Darden's ecommerce events did exactly that for nine months after a script-loading
change. Every one of those days returns an honest zero from the API, and a yearly funnel would
render it as a collapse in trade rather than a gap in measurement. `eventCutovers` therefore accepts
`{ from, outages: [{ start, until, reason }] }`, and a range inside an outage reports as unavailable
rather than as zero.

**A missing metric is never zero.** Every figure is a `MetricValue` tagged union, so an
uninstrumented event cannot silently coerce to `0` and be charted as a real trough. Unavailable
figures render as an em dash with a stated reason.

**The journey is a funnel, not a path.** GA4's Data API has no path-exploration endpoint, and
`runFunnelReport` returns step-conversion marginals rather than observed sequences. Drawing a flow
diagram from that would assert co-occurrence nobody measured. Steps are reported as independent
totals and the response is flagged approximate.

**Auth is the Studio's own session token.** The Studio forwards its Sanity token and the route
verifies it against Sanity. A shared secret would be extractable from the public Studio bundle,
moving the bar from "know the URL" to "open devtools", and would give no identity to audit.

**No charting library.** These panels compare and rank a handful of values, which labelled bars and
tables do as well as a chart — without a large Studio-bundle dependency or theme-token bridging for
light and dark. Tables are the accessible representation *and* the visual one, so they cannot drift
apart.

**No customer data leaves Sanity.** Order queries project `{_createdAt, orderStatus}` and, for the
interest panel, dereference only a typeface title. Joining behavioural data to order PII would turn
aggregate statistics into personal-data processing.

---

## Diagnostics — run this first

The panels are only as trustworthy as the property behind them, and the ways a GA4 property
quietly produces wrong numbers are not visible from the numbers themselves. The Diagnostics panel
measures them:

- **GA4 reachable** — distinguishes a bad service-account key from missing Viewer access.
- **Timezone matches config** — a mismatch shifts day and week boundaries, so GA4, Vercel and
  Sanity stop agreeing which period an event belongs to.
- **Retention covers a year** — probes a window beyond the 2-month default rather than asking you
  to read the Admin screen. This is the check most likely to explain an empty year range.
- **Configured events fire** — catches a cutover map claiming an event is live when GA4 has never
  seen it, which otherwise produces figures that look real but are not.
- **Purchases carry `transaction_id`** — without it a GA4 purchase cannot be reconciled against a
  Sanity order at all.
- **GA4 purchases match orders** — a large divergence usually means `purchase` fires on a page some
  buyers never reach, fires twice, or is being blocked.

It is also the one panel that still says something useful with nothing configured, so it is worth
opening the moment credentials land. Available in the Studio, or headless:

```ts
import { runDiagnostics } from '@liiift-studio/sanity-visitor-insights/server'

const report = await runDiagnostics({ config, ga4, vercel, sanity })
console.log(report.verdict, report.checks)
```

---

## Testing without credentials

Test doubles ship from a separate subpath, so a consuming site can exercise these reports before
it has anything to point at:

```ts
import { createFakeGa4Client, makeGa4Total } from '@liiift-studio/sanity-visitor-insights/testing'

const ga4 = createFakeGa4Client({ batch: () => [makeGa4Total(800), makeGa4Total(300), makeGa4Total(0)] })
const data = await measurementHealth({ config, range, ga4, vercel: null, sanity: null })
```

The fakes record what they were asked, so a test can assert on the GROQ that ran — which is how
this package proves no customer field is ever projected.

---

## Installing

```bash
npm install @liiift-studio/sanity-visitor-insights
```

### 1. Studio

```ts
// sanity.config.ts
import { visitorInsights } from '@liiift-studio/sanity-visitor-insights'

export default defineConfig({
  plugins: [
    visitorInsights({
      apiBaseUrl: 'https://dardenstudio.com',
      siteLabel: 'Darden Studio',
      roles: ['administrator'],
    }),
  ],
})
```

Pass `apiBaseUrl: ''` when the Studio is served from the same origin as the site (Darden and TDF).
MCKL's Studio deploys separately to `mckl.sanity.studio`, so it needs the full site URL.

Omit `roles` to show the tool to every Studio user. These panels read order-derived conversion
figures, so gating to administrators is usually right.

### 2. Site API route

```js
// pages/api/visitor-insights/[report].js
import { createVisitorInsightsHandler } from '@liiift-studio/sanity-visitor-insights/server'
import { client } from '../../../lib/sanityClient'

export default createVisitorInsightsHandler({
  sanityClient: client,
  config: {
    siteId: 'darden',
    label: 'Darden Studio',
    ga4: { propertyId: '123456789', timezone: 'America/New_York' },
    vercel: { projectId: 'prj_...' },
    orders: { documentType: 'order', typefacesField: 'typefaces' },
    eventCutovers: {
      page_view: 'preexisting',
      view_item: 'preexisting',
      add_to_cart: 'preexisting',
      begin_checkout: 'preexisting',
      purchase: 'preexisting',
      consent_granted: null,
      tester_engaged: null,
    },
    // Only needed where the Studio is on a different origin.
    allowedStudioOrigins: ['https://mckl.sanity.studio'],
  },
})
```

`propertyId` is the **numeric** GA4 property id from GA4 Admin, not the `G-XXXXXXX` measurement id.
The config is validated at construction and will throw on deploy rather than silently returning
empty charts — pasting a measurement id here is caught by name.

### 3. Environment variables

| Variable | Where | What |
|---|---|---|
| `VISITOR_INSIGHTS_GA4_SERVICE_ACCOUNT` | Site (server) | Service-account JSON, raw or base64 |
| `VISITOR_INSIGHTS_VERCEL_TOKEN` | Site (server) | Vercel API token with project read access |
| `SANITY_STUDIO_PROJECT_ID` | Site (server) | Already set; used to verify Studio tokens |

The service account needs **Viewer** on each GA4 property. Nothing here is `NEXT_PUBLIC_`; none of
it reaches the browser.

---

## Before it will show anything useful

- **Set GA4 data retention to 14 months** on every property (Admin → Data Settings → Data
  Retention). The default may be 2 months, which makes the year range return nothing for most of
  its span. It does not backfill, so every day at the default is data lost permanently.
- **Register custom dimensions before deploying the events that populate them.** A dimension only
  reports from its registration date forward.
- **Instrument `consent_granted` and `tester_engaged`.** Without them the measurement-health
  residual stays unexplained and the journey funnel has a hole where the tester belongs.
- **`tester_engaged` must require a change from the tester's default state** — custom text, or a
  weight/size change. Firing on tester open counts every page load as a test and makes the
  viewed-to-tested ratio meaningless.

---

## Development

```bash
npm install
npm test          # pure logic plus the client/server boundary guard
npm run build
```

The boundary test walks the real import graph from each entry point and fails if anything reachable
from the Studio entry touches `src/server/`, `node:crypto` or `process.env`. That check exists
because the failure it prevents — a credential-reading module shipped in a public Studio bundle —
is invisible to type checking and to review.

---

## Architecture

```
src/
  types.ts          MetricValue, ranges, report envelope
  reportData.ts     Result shapes shared by server and panels, importing neither
  core/             Pure logic: cutovers, range resolution, config validation
  server/           Node only — GA4, Vercel, Sanity, auth, cache, handler factory
  studio/           Browser only — the tool, panels and figure renderers
```

`core/` and `reportData.ts` are shared. Nothing in `studio/` may import from `server/`, which is
what the split export subpaths and the boundary test enforce together.
