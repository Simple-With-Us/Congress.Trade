/**
 * CT-local extensions to vendored congress-trading-shared market read shapes.
 * Keep vendored src/ byte-identical to upstream; extend here for Congress.Trade-only
 * response fields (see shared-package-pin-check.yml).
 */

import { z } from 'zod';
import { IsoDateSchema, PriceSeriesSchema } from '@jaywedgeworth22/congress-trading-shared';

/** GET /api/market/prices/:ticker (and bundle prices leg) read response. */
export const MarketPriceSeriesReadSchema = PriceSeriesSchema.extend({
  stale: z.boolean().optional(),
  freshThrough: IsoDateSchema.optional(),
  dataAgeDays: z.number().int().nonnegative().optional(),
});
export type MarketPriceSeriesRead = z.infer<typeof MarketPriceSeriesReadSchema>;
