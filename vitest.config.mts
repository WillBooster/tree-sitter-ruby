import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tsconfig.json declares the `vitest/globals` types, so the runner must provide those globals.
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          globalSetup: 'test/helpers/installCli.ts',
          include: ['test/unit/*.test.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          include: ['test/unit/browser/*.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
            // The page has no UI to show.
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
