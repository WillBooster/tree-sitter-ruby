import path from 'node:path';
import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

test.each(['\f', '\v'])('preserves statements after a heredoc label followed by %j', async (whitespace) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(`value = <<EOS${whitespace}\nhello\nEOS\nfollowing = 1\n`)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.namedChildren.map(({ type }) => type)).toEqual(['assignment', 'heredoc_body', 'assignment']);
    expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
    expect(tree.rootNode.descendantsOfType('heredoc_end').map(({ text }) => text)).toEqual(['EOS']);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([
  ['string', '"a #{<<EOS} b\nbody\nEOS\nc"'],
  ['string without a prefix', '"#{<<EOS}\nbody\nEOS\nc"'],
  ['percent string', '%Q[a #{<<EOS} b\nbody\nEOS\nc]'],
  ['default percent string', '%(a #{<<EOS} b\nbody\nEOS\nc)'],
  ['subshell', '`a #{<<EOS} b\nbody\nEOS\nc`'],
  ['regexp', '/a#{<<EOS} b\nbody\nEOS\nc/'],
  ['word array', '%W[a #{<<EOS} b\nbody\nEOS\nc]'],
  ['symbol array', '%I[a #{<<EOS} b\nbody\nEOS\nc]'],
  ['quoted symbol', ':"a #{<<EOS} b\nbody\nEOS\nc"'],
  ['CRLF', '"a #{<<EOS} b\r\nbody\r\nEOS\r\nc"'],
  ['CRLF word array', '%W[a #{<<EOS} b\r\n  body\r\nEOS\r\nc]'],
  ['word array with a bare CR', '%W[a #{<<EOS} b\rc\nbody\nEOS\nd]'],
  ['string with a bare CR', '"a #{<<EOS} b\rc\nbody\nEOS\nd"'],
  ['nested string', '"a #{"#{<<EOS} b\nbody\nEOS\nc"} d"'],
  ['non-interpolating heredoc', '"a #{<<\'EOS\'} b\n#{body}\nEOS\nc"'],
  ['escaped newline', '"#{<<EOS} b\\\nbody\nEOS\nc"'],
])('preserves a heredoc and following statements inside a multiline %s', async (_, literal) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(`value = ${literal}\nfollowing = 1\n`)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.namedChildren.map(({ type }) => type)).toEqual(['assignment', 'assignment']);
    expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
    const value = tree.rootNode.namedChildren[0]!.childForFieldName('right')!;
    const bodies = value.descendantsOfType('heredoc_body');
    expect(bodies).toHaveLength(1);
    expect(
      bodies[0]!
        .descendantsOfType('heredoc_content')
        .map(({ text }) => text)
        .join('')
    ).toContain('body');
    expect(bodies[0]!.descendantsOfType('heredoc_end').map(({ text }) => text)).toEqual(['EOS']);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('starts a pending heredoc across contiguous ranges after an escaped newline', async () => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  const source = 'value = "#{<<EOS} b\\\nbody\nEOS\nc"\nfollowing = 1\n';
  const split = source.indexOf('body');
  const endLines = source.split('\n');
  const tree = parser.parse(source, undefined, {
    includedRanges: [
      {
        startIndex: 0,
        endIndex: split,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 1, column: 0 },
      },
      {
        startIndex: split,
        endIndex: source.length,
        startPosition: { row: 1, column: 0 },
        endPosition: { row: endLines.length - 1, column: endLines.at(-1)!.length },
      },
    ],
  })!;
  const full = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.toString()).toBe(full.rootNode.toString());
    expect(tree.rootNode.descendantsOfType('heredoc_content').map(({ text }) => text)).toEqual(['body\n']);
    expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
  } finally {
    tree.delete();
    full.delete();
    parser.delete();
  }
});

test.each([
  ['single-quoted string', "'", "'"],
  ['percent string', '%q[', ']'],
  ['word array', '%w[', ']'],
  ['symbol array', '%i[', ']'],
])('starts a pending heredoc after an escaped newline in a %s', async (_, open, close) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      const source = `value = [<<EOS, ${open}a\\${newline}body${newline}EOS${newline}b${close}]\nfollowing = 1\n`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(
          tree.rootNode
            .descendantsOfType('heredoc_content')
            .map(({ text }) => text)
            .join('')
        ).toBe(`body${newline}`);
        expect(tree.rootNode.descendantsOfType('heredoc_end').map(({ text }) => text)).toEqual(['EOS']);
        expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
