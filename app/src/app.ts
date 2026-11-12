/**
 * ENGINEERINGQUALITY-02: this file used to assemble a second, unused Hono app
 * (the only place Apple's webhook was mounted). Production is index.ts.
 * Leftover imports get that same app so the assemblies cannot drift.
 */
export { honoApp as default } from './index.ts';
