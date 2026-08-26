/**
 * Testing entry point — test doubles for the report layer.
 *
 * Behind its own subpath so these never reach a production server or Studio bundle, while still
 * being available to a consuming site that wants to exercise these reports before it has
 * credentials to point at.
 *
 *   import { createFakeGa4Client } from '@liiift-studio/sanity-visitor-insights/testing'
 */

export * from './testing/fakes'
