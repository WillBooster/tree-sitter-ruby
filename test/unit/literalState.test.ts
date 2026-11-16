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

test.each(['w', 'W', 'i', 'I'])('separates escaped percent-%s words at source whitespace', (kind) => {
  const source = String.raw`p %${kind}[hello \n]`;
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    const node = tree.rootNode;
    expect(node.hasError).toBe(false);
    const words = node.descendantsOfType(kind === 'i' || kind === 'I' ? 'bare_symbol' : 'bare_string');
    expect(words.map(({ text }) => text)).toEqual(['hello', String.raw`\n`]);
    nativeParser.check(source, node);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['q', 'Q'])('parses percent-%s after a string as a formatting operation', (kind) => {
  const source = `p "a%s" %${kind}(b)`;
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    const node = tree.rootNode;
    expect(node.hasError).toBe(false);
    expect(node.descendantsOfType('binary').map(({ text }) => text)).toEqual([`"a%s" %${kind}(b)`]);
    expect(node.descendantsOfType('chained_string')).toHaveLength(0);
    nativeParser.check(source, node);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['p %Q(a) "b"', 'p "a" "b"', String.raw`p %W[a\ b #{1} \n]`])(
  'retains genuine concatenation and escaped word content: %s',
  (source) => {
    const parser = new Parser().setLanguage(language);
    const tree = parser.parse(source)!;
    try {
      const node = tree.rootNode;
      expect(node.hasError).toBe(false);
      if (source.startsWith('p %W'))
        expect(node.descendantsOfType('bare_string').map(({ text }) => text)).toEqual([
          String.raw`a\ b`,
          '#{1}',
          String.raw`\n`,
        ]);
      else expect(node.descendantsOfType('chained_string')).toHaveLength(1);
      nativeParser.check(source, node);
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);

test.each(['W', 'I'])('keeps an escaped percent-%s word across its heredoc body', (kind) => {
  const source = String.raw`value = %${kind}[#{<<EOS}\
body
EOS
\n]
`;
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    const node = tree.rootNode;
    expect(node.hasError).toBe(false);
    const words = node.descendantsOfType(kind === 'I' ? 'bare_symbol' : 'bare_string');
    expect(words).toHaveLength(1);
    expect(words[0]!.descendantsOfType('interpolation')).toHaveLength(1);
    expect(words[0]!.descendantsOfType('escape_sequence').map(({ text }) => text)).toEqual([String.raw`\n`]);
    nativeParser.check(source, node);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['w', 'i', 'W', 'I'])('retains complete escaped line endings in percent-%s words', (kind) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n'])
      for (const prefix of ['', ' ', 'first ', 'first']) {
        const source = `%${kind}[${prefix}\\${newline}second]`;
        const tree = parser.parse(source)!;
        try {
          const node = tree.rootNode;
          expect(node.hasError, source).toBe(false);
          const words = node.descendantsOfType(kind.toLowerCase() === 'i' ? 'bare_symbol' : 'bare_string');
          expect(
            words.map(({ text }) => text),
            source
          ).toEqual(prefix === 'first ' ? ['first', `\\${newline}second`] : [`${prefix.trim()}\\${newline}second`]);
          nativeParser.check(source, node);
        } finally {
          tree.delete();
        }
      }
  } finally {
    parser.delete();
  }
});
