/** Recent trade timestamps so delivery freshness gates pass under wall-clock test runs. */
export const freshDeliveryAnchor = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
export const freshDeliveryDay = freshDeliveryAnchor.toISOString().slice(0, 10);
export const freshDeliveryIso = freshDeliveryAnchor.toISOString();
