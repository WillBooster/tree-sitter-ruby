import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';
import { NativeParser } from '../helpers/nativeParser.js';

const root = path.join(import.meta.dirname, '../..');
let language: Language;
let nativeParser: NativeParser;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(root));
  nativeParser = new NativeParser(root);
}, 300_000);

afterAll(() => nativeParser?.dispose());

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
    nativeParser.check(source, node);
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
    nativeParser.check(source, node);
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
    nativeParser.check(source, tree.rootNode);
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
