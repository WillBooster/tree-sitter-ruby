import path from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

// The same Worker with and without Node.js compatibility, since the grammar must run in both.
const Configs = {
  'tree-sitter-ruby-test': 'wrangler.jsonc',
  'tree-sitter-ruby-test-no-nodejs-compat': 'wrangler.no-nodejs-compat.jsonc',
};

let harness: TestHarness | undefined;

beforeAll(async () => {
  harness = createTestHarness({
    workers: Object.values(Configs).map((config) => ({
      configPath: path.join(import.meta.dirname, '../fixtures/workerd', config),
    })),
  });
  await harness.listen();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

test.each(Object.keys(Configs))('parses in Cloudflare Workers with the imported Wasm modules (%s)', async (name) => {
  const response = await harness!.getWorker(name).fetch('http://localhost/', { method: 'POST', body: 'puts "Hello"' });
  expect(await response.text()).toBe(
    '(program (call method: (identifier) arguments: (argument_list (string (string_content)))))'
  );
});
