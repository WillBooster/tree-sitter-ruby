import path from 'node:path';

import { Language, Parser, type Point, type Range } from '@willbooster/web-tree-sitter';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

let language: Language;
let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
});
beforeEach(() => {
  parser = new Parser();
  parser.setLanguage(language);
});
afterEach(() => parser.delete());

test.each([
  ['<% # first %>\n<p>HTML</p>\n<% value %>', '(program (comment) (identifier))', ['# first ']],
  ['<% if ready # why %>\n<p>HTML</p>\n<% end %>', '(program (if condition: (identifier) (comment)))', ['# why ']],
  ['<%# one %><%# two %><% value %>', '(program (comment) (comment) (identifier))', ['# one ', '# two ']],
  ['<% # first%>\n<p>HTML</p>\n<%\nvalue %>', '(program (comment) (identifier))', ['# first']],
  ['<% foo\n# c %>\n<% bar %>', '(program (identifier) (comment) (identifier))', ['# c ']],
  ['<% foo\n  # c %>\n<% bar %>', '(program (identifier) (comment) (identifier))', ['# c ']],
  ['<% foo\n# c\n.bar %>', '(program (call receiver: (identifier) (comment) method: (identifier)))', ['# c']],
  ['<% foo\n# c %><% .bar %>', '(program (identifier) (comment) (ERROR) (identifier))', ['# c ']],
  ['<% foo\n# c %><% &.bar %>', '(program (identifier) (comment) (ERROR) (identifier))', ['# c ']],
  ['<% foo %><% .bar %>', '(program (identifier) (ERROR) (identifier))', []],
  ['<% foo\n%>\n<% &.bar %>', '(program (identifier) (ERROR) (identifier))', []],
  ['<% __END__ %>\n<p>x</p>\n<% # data %><% y %>', '(program (identifier) (comment) (identifier))', ['# data ']],
  ['<% # last %>', '(program (comment))', ['# last ']],
  ['<% # first\nvalue %>', '(program (comment) (identifier))', ['# first']],
] as const)('ends included comments without swallowing later Ruby: %s', (source, expected, comments) => {
  const tree = parser.parse(source, undefined, { includedRanges: includedRanges(source) })!;
  try {
    expect(tree.rootNode.toString()).toBe(expected);
    expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(comments);
  } finally {
    tree.delete();
  }
});

test.each([
  ['\n# ordinary\nvalue', '(program (comment) (identifier))', ['# ordinary']],
  ['value # trailing', '(program (identifier) (comment))', ['# trailing']],
  ['value\n__END__\n# data', '(program (identifier) (uninterpreted))', []],
  ['=begin\nblock\n=end\nvalue', '(program (comment) (identifier))', ['=begin\nblock\n=end']],
] as const)('preserves ordinary comment tokens and their spans: %s', (source, expected, comments) => {
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.toString()).toBe(expected);
    expect(tree.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(comments);
  } finally {
    tree.delete();
  }
});

test.each([
  ['x = <<~EOS; __END__\ndata\nEOS', ['\ndata\nEOS']],
  ['foo(<<~EOS); __END__\nbody\nEOS', ['\nbody\nEOS']],
  ['foo(<<A, <<B); __END__\na\nA\nb\nB', ['\na\nA', '\nb\nB']],
] as const)('retains heredoc bodies after an ordinary __END__ identifier: %s', (source, bodies) => {
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('heredoc_body').map((node) => node.text)).toEqual(bodies);
    expect(tree.rootNode.descendantsOfType('uninterpreted')).toHaveLength(0);
    expect(tree.rootNode.descendantsOfType('identifier').map((node) => node.text)).toContain('__END__');
  } finally {
    tree.delete();
  }
});

test('owns comments at included body boundaries', () => {
  const source = '<% def example %>\n<% # body %>\n<% value %>\n<% end %>';
  const tree = parser.parse(source, undefined, { includedRanges: includedRanges(source) })!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const body = tree.rootNode.firstNamedChild!.childForFieldName('body')!;
    const comment = body.firstNamedChild!;
    expect(comment.type).toBe('comment');
    expect(comment.text).toBe('# body ');
    expect(comment.startIndex).toBe(source.indexOf('# body'));
    expect(comment.endIndex).toBe(source.indexOf('%>', comment.startIndex));
    expect(comment.nextNamedSibling?.text).toBe('value');
  } finally {
    tree.delete();
  }
});

test.each(['|value|', '||'])('keeps included comments before block parameters %s', (parameters) => {
  const source = `<% foo do %>\n<% # header %>\n<% ${parameters} %>\n<% # body %>\n<% value %>\n<% end %>`;
  const tree = parser.parse(source, undefined, { includedRanges: includedRanges(source) })!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const block = tree.rootNode.firstNamedChild!.childForFieldName('block')!;
    expect(block.childForFieldName('parameters')!.text).toBe(parameters);
    expect(block.namedChildren[0]!.text).toBe('# header ');
    expect(block.namedChildren[0]!.startIndex).toBe(source.indexOf('# header'));
    expect(block.namedChildren[0]!.endIndex).toBe(source.indexOf('%>', source.indexOf('# header')));
    expect(block.childForFieldName('body')!.namedChildren.map(({ text }) => text)).toEqual(['# body ', 'value']);
  } finally {
    tree.delete();
  }
});

function includedRanges(source: string): Range[] {
  return [...source.matchAll(/<%([\s\S]*?)%>/g)].map((match) => {
    const startIndex = match.index + 2;
    const endIndex = startIndex + match[1]!.length;
    return { startIndex, endIndex, startPosition: pointAt(source, startIndex), endPosition: pointAt(source, endIndex) };
  });
}

function pointAt(source: string, index: number): Point {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}
