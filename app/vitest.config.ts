import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@jaywedgeworth22/congress-trading-shared': './vendor/congress-trading-shared/src/index.ts',
    },
  },
  test: {
    exclude: ['vendor/**', 'node_modules/**'],
    // Pins CT_DELIVERY_MODE=deliver so suites that never boot the settings
    // service keep today's delivery behavior; deliveryMode.test.ts clears it.
    setupFiles: ['./src/__tests__/setupDeliveryMode.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      clean: true,
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'vendor/**',
        'src/**/__tests__/**',
      ],
      // Initial whole-app floor sits below the measured baseline
      // (63.81/56.37/69.12/65.64) so adoption is non-blocking, while still
      // preventing a large silent regression. Ratchet upward over time.
      thresholds: {
        statements: 55,
        branches: 45,
        functions: 60,
        lines: 55,
      },
    },
  },
});
