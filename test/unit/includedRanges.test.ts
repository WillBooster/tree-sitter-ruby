import { readFile } from 'node:fs/promises';
import { Edit, Language, Parser, type Point, type Range } from '@willbooster/web-tree-sitter';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';

let language: Language;
let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(await readFile(new URL('../../tree-sitter-ruby.wasm', import.meta.url)));
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
  ['<% __END__ %>\n<p>x</p>\n<% # data %><% y %>', '(program (uninterpreted))', []],
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

test.each(['<% if ready # old %>\n<p>HTML</p>\n<% end %>', '<% if ready\n# old %>\n<p>HTML</p>\n<% end %>'])(
  'reparses an edited included comment without losing the following block terminator: %s',
  (source) => {
    const changed = source.replace('old', 'new comment');
    const tree = parser.parse(source, undefined, { includedRanges: includedRanges(source) })!;
    const startIndex = source.indexOf('old');
    tree.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex + 3,
        newEndIndex: startIndex + 11,
        startPosition: pointAt(source, startIndex),
        oldEndPosition: pointAt(source, startIndex + 3),
        newEndPosition: pointAt(changed, startIndex + 11),
      })
    );
    const incremental = parser.parse(changed, tree, { includedRanges: includedRanges(changed) })!;
    const fresh = parser.parse(changed, undefined, { includedRanges: includedRanges(changed) })!;
    try {
      expect(incremental.rootNode.toString()).toBe('(program (if condition: (identifier) (comment)))');
      expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
      expect(incremental.rootNode.descendantsOfType('comment').map((node) => node.text)).toEqual(['# new comment ']);
    } finally {
      fresh.delete();
      incremental.delete();
      tree.delete();
    }
  }
);

test.each([
  ['x = <<~EOS; __END__\ndata\nEOS', ['\ndata\nEOS']],
  ['foo(<<~EOS); __END__\nbody\nEOS', ['\nbody\nEOS']],
  ['foo(<<A, <<B); __END__\na\nA\nb\nB', ['\na\nA', '\nb\nB']],
] as const)('retains pending heredoc bodies before raw data in incomplete Ruby: %s', (source, bodies) => {
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('heredoc_body').map((node) => node.text)).toEqual(bodies);
    expect(tree.rootNode.descendantsOfType('uninterpreted').map((node) => node.text)).toEqual(['']);
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
