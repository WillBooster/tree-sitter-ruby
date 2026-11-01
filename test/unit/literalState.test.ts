import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

const root = path.join(import.meta.dirname, '../..');
let language: Language;
let directory: string;
let nativeLibrary: string;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(root));
  directory = fs.mkdtempSync(path.join(root, '.tmp/literal-state-'));
  nativeLibrary = path.join(directory, 'ruby.dylib');
  execFileSync('script/tree-sitter', ['build', '--output', nativeLibrary, root], { cwd: root, timeout: 300_000 });
}, 300_000);

afterAll(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test.each([170, 171, 256, 512])('retains all nested interpolated strings at depth %i', (depth) => {
  const literal = nestedLiteral(depth);
  const source = `${literal}\nfollowing`;
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    const node = tree.rootNode;
    expect(node.hasError).toBe(false);
    expect(node.descendantsOfType('string')).toHaveLength(depth);
    expect(node.descendantsOfType('interpolation')).toHaveLength(depth);
    expect(node.descendantsOfType('integer').map(({ text }) => text)).toEqual(['1']);
    expect(node.firstNamedChild!.text).toBe(literal);
    expect(node.lastNamedChild!.text).toBe('following');
    checkNative(source, node);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([65_535, 65_536, 65_537])('retains percent-literal delimiter depth %i across interpolation', (depth) => {
  const literal = `%${'('.repeat(depth)}#{1}${')'.repeat(depth)}`;
  const source = `${literal}\nfollowing`;
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    const node = tree.rootNode;
    expect(node.hasError).toBe(false);
    expect(node.descendantsOfType('string')).toHaveLength(1);
    expect(node.descendantsOfType('interpolation')).toHaveLength(1);
    expect(node.descendantsOfType('integer').map(({ text }) => text)).toEqual(['1']);
    expect(node.firstNamedChild!.text).toBe(literal);
    expect(node.lastNamedChild!.text).toBe('following');
    checkNative(source, node);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('reports an unterminated deeply nested literal', () => {
  const source = nestedLiteral(171).slice(0, -1);
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(true);
    checkNative(source, tree.rootNode);
  } finally {
    tree.delete();
    parser.delete();
  }
});

function nestedLiteral(depth: number): string {
  const delimiters = [
    ['"#{', '}"'],
    ['%Q(#{', '})'],
    ['%Q[#{', '}]'],
    ['%Q{#{', '}}'],
  ] as const;
  const openings = Array.from({ length: depth }, (_, index) => delimiters[index % delimiters.length]![0]);
  const closings = Array.from({ length: depth }, (_, index) => delimiters[index % delimiters.length]![1]);
  return `${openings.join('')}1${closings.toReversed().join('')}`;
}

function checkNative(source: string, node: Node): void {
  const file = path.join(directory, `${createHash('sha256').update(source).digest('hex')}.rb`);
  fs.writeFileSync(file, source);
  const result = spawnSync(
    'script/tree-sitter',
    ['parse', '--lib-path', nativeLibrary, '--lang-name', 'ruby', '--no-ranges', file],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(node.hasError ? 1 : 0);
  if (!node.hasError) expect(result.stdout.trim().replaceAll(/\s+/g, ' ')).toBe(node.toString());
}
