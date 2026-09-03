/**
 * Server entry point — Node only.
 *
 * Nothing here may be imported from the Studio entry (`src/index.ts`). This module reaches
 * node:crypto and reads service-account credentials from the environment; keeping it behind its
 * own export subpath is what guarantees a bundler cannot pull it into a Studio browser bundle.
 */

export { createVisitorInsightsHandler, ENV_VARS, type HandlerOptions } from './server/createHandler'
export type { HandlerRequest, HandlerResponse, StudioUser } from './server/auth'
export { verifyStudioRequest, requireStudioUser, applyCors } from './server/auth'
export { countOrders, countOrdersByTypeface, orderQueryOptions, UNKNOWN_STATUS } from './server/orders'
export type { OrderCounts, OrderQueryOptions, SanityQueryClient, TypefaceOrderCounts } from './server/orders'
export { clearCache } from './server/cache'

// Report result shapes, so a consuming site can type a custom surface against them.
export type { MeasurementHealthData } from './server/reports/measurementHealth'
export type { AcquisitionData, SourceRow } from './server/reports/acquisition'
export type { JourneyData, JourneyStep, LandingPage } from './server/reports/journey'
export type { TypefaceInterestData, TypefaceInterestRow } from './server/reports/typefaceInterest'
export { JOURNEY_STEPS } from './server/reports/journey'
export { DESIGN_INDUSTRY_SOURCES } from './server/reports/acquisition'
export { runDiagnostics, type DiagnosticsInput } from './server/diagnostics'

// Client constructors. Needed to call runDiagnostics headlessly, which the README documents —
// without these exported that example could not actually be written.
export { createGa4Client, eventNameFilter, sumFirstMetric, type Ga4Client, type Ga4Report, type Ga4ReportRequest } from './server/ga4'
export { createVercelClient, type VercelClient, type VercelPageviews } from './server/vercel'
export { parseServiceAccountKey, type ServiceAccountKey } from './server/googleAuth'
// Every response shape, not a hand-picked three. A consumer building a compatibility shim needs
// to name the type of whatever the route returned.
export type * from './reportData'

// Shared contract, re-exported so the server entry is self-sufficient.
export * from './types'
export * from './core/cutover'
export * from './core/siteConfig'
export * from './core/ranges'
