/**
 * Explicit Sentry v11 `dataCollection` policy for diagnostics that must not
 * carry account-linkable identifiers (not-linked posture).  `sendDefaultPii:
 * false` alone does not disable v11 automatic request/user/body collection.
 */

export const NOT_LINKED_SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as const,
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
};
