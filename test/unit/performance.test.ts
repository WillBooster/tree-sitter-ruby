import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

const Root = path.join(import.meta.dirname, '../..');
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(currentWasmPath(Root)));

// Thread CPU excludes concurrent test workers and background Wasm compilation/collection.
// The ratio allows headroom over tenfold input growth while detecting quadratic work.
test('recovers from an error on each line with bounded CPU growth', { timeout: 60_000 }, () => {
  const line = '$ a\n';
  const small = line.repeat(2000);
  const large = line.repeat(20_000);
  parseCpuTime(large);
  parseCpuTime(large);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCpuTime(small));
    largeFastest = Math.min(largeFastest, parseCpuTime(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  // process.threadCpuUsage reports microseconds.
  expect(largeFastest).toBeLessThan(5_000_000);
});

test('continues calls through comment chains with bounded CPU growth', { timeout: 60_000 }, () => {
  const small = `receiver\n${'# comment\n'.repeat(500)}.call\n`;
  const large = `receiver\n${'# comment\n'.repeat(5000)}.call\n`;
  checkCommentGrowth(small, large);
});

test.each([
  ['method', 'def x\n', '  value\nend\n'],
  ['class', 'class X\n', '  value\nend\n'],
  ['module', 'module X\n', '  value\nend\n'],
  ['do block', 'foo do\n', '  value\nend\n'],
  ['comment-only method', 'def x\n', 'end\n'],
  ['comment-only class', 'class X\n', 'end\n'],
  [
    'near-capacity heredoc interpolation',
    `x = <<~${'A'.repeat(1018)}\n#{class Nested < receiver\n`,
    `.call\nend}\n${'A'.repeat(1018)}\nfoo\n`,
  ],
] as const)('bounds leading comment growth in a %s', { timeout: 60_000 }, (_, header, tail) => {
  const small = `${header}${'  # comment\n'.repeat(500)}${tail}`;
  const large = `${header}${'  # comment\n'.repeat(5000)}${tail}`;
  checkCommentGrowth(small, large);
});

function checkCommentGrowth(small: string, large: string): void {
  parseCpuTime(large, false);
  let smallFastest = Infinity;
  let largeFastest = Infinity;
  for (let run = 0; run < 5; run++) {
    smallFastest = Math.min(smallFastest, parseCommentSample(small));
    largeFastest = Math.min(largeFastest, parseCommentSample(large));
  }
  expect(largeFastest / smallFastest).toBeLessThan(18);
  expect(largeFastest).toBeLessThan(5_000_000);
}

function parseCpuTime(source: string, expectedError = true): number {
  const start = process.threadCpuUsage();
  const tree = parser.parse(source);
  const { system, user } = process.threadCpuUsage(start);
  if (!tree) throw new Error('The parser returned no tree');
  const { hasError } = tree.rootNode;
  tree.delete();
  expect(hasError).toBe(expectedError);
  return system + user;
}

function parseCommentSample(source: string): number {
  const start = process.threadCpuUsage();
  let parses = 0;
  let microseconds = 0;
  let errors = 0;
  do {
    const tree = parser.parse(source);
    if (!tree) throw new Error('The parser returned no tree');
    errors += Number(tree.rootNode.hasError);
    tree.delete();
    parses++;
    const { system, user } = process.threadCpuUsage(start);
    microseconds = system + user;
  } while (microseconds < 50_000 && parses < 4096);
  expect(errors).toBe(0);
  expect(microseconds).toBeGreaterThan(0);
  return microseconds / parses;
}
