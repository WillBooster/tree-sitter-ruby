import path from 'node:path';

import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

let language: Language;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
});

test.each([
  'def example',
  'def example(value)',
  'def example;',
  'def example(value);',
  'def example value',
  'def self.example',
  'class Example',
  'class Example;',
  'class Example < Parent',
  'class << self',
  'module Example',
  'module Example;',
])('owns leading comments in the body of %s', (header) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      const carriageReturn = newline.slice(0, -1);
      const source = `# outside${newline}${header} # header${newline}  # leading${newline}  # second${newline}  first${newline}  # middle${newline}  second${newline}end${newline}following`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const declaration = tree.rootNode.namedChildren[1]!;
        const body = declaration.childForFieldName('body')!;
        expect(body.type).toBe('body_statement');
        expect(body.namedChildren.map(({ type, text }) => [type, text])).toEqual([
          ['comment', `# leading${carriageReturn}`],
          ['comment', `# second${carriageReturn}`],
          ['identifier', 'first'],
          ['comment', `# middle${carriageReturn}`],
          ['identifier', 'second'],
        ]);
        expect(body.startIndex).toBe(source.indexOf('# leading'));
        expect(body.endIndex).toBe(source.indexOf('\nend'));
        expect(body.namedChildren[0]!.nextNamedSibling?.text).toBe(`# second${carriageReturn}`);
        expect(body.namedChildren[1]!.nextNamedSibling?.text).toBe('first');
        expect(declaration.namedChildren.filter(({ type }) => type === 'comment').map(({ text }) => text)).toEqual([
          `# header${carriageReturn}`,
        ]);
        expect(declaration.nextNamedSibling?.text).toBe('following');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['def example', 'class Example', 'module Example'])('retains a comment-only %s body', (header) => {
  const parser = new Parser().setLanguage(language);
  const source = `${header}\n  # only\nend`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const body = tree.rootNode.firstNamedChild!.childForFieldName('body')!;
    expect(body.type).toBe('body_statement');
    expect(body.namedChildren.map(({ text }) => text)).toEqual(['# only']);
    expect(body.startIndex).toBe(source.indexOf('# only'));
    expect(body.endIndex).toBe(source.indexOf('\nend'));
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('keeps block comments and rescue clauses in the method body', () => {
  const source = 'def example\n=begin\nleading\n=end\n  first\nrescue\n  recovered\nensure\n  finished\nend';
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const body = tree.rootNode.firstNamedChild!.childForFieldName('body')!;
    expect(body.namedChildren.map(({ type }) => type)).toEqual(['comment', 'identifier', 'rescue', 'ensure']);
    expect(body.firstNamedChild!.text).toBe('=begin\nleading\n=end');
    expect(body.firstNamedChild!.nextNamedSibling?.text).toBe('first');
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([
  ['# before parameters', '|x|'],
  ['# before parameters', '||'],
  ['=begin\nbefore parameters\n=end', '|x|'],
  ['=begin\nbefore parameters\n=end', '||'],
])('preserves %j before do-block parameters %s', (comment, parameters) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      const prefix = `foo do\n${comment}\n`;
      const source = `${prefix}${parameters}\n  # body\n  x\nend`.replaceAll('\n', newline);
      const startIndex = prefix.replaceAll('\n', newline).length;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const block = tree.rootNode.firstNamedChild!.childForFieldName('block')!;
        expect(block.childForFieldName('parameters')!.text).toBe(parameters);
        expect(block.namedChildren[0]!.type).toBe('comment');
        expect(block.namedChildren[0]!.startIndex).toBe(source.indexOf(comment.split('\n')[0]!));
        expect(block.namedChildren[0]!.endIndex).toBe(startIndex - 1);
        expect(block.childForFieldName('body')!.namedChildren.map(({ text }) => text)).toEqual([
          `# body${newline.slice(0, -1)}`,
          'x',
        ]);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each([
  ['receiver\n# between\n.call', 'call'],
  ['receiver\n# one\n# two\n&.call', 'call'],
  ['first\n# between\nand second', 'binary'],
  ['first\n# between\nor second', 'binary'],
  ['first\n# between\n|| second', 'binary'],
])('preserves continuation through comments in %j', (source, type) => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.namedChildren).toHaveLength(1);
    expect(tree.rootNode.firstNamedChild!.type).toBe(type);
    expect(tree.rootNode.firstNamedChild!.descendantsOfType('comment').map(({ text }) => text)).toEqual(
      source.split('\n').filter((line) => line.startsWith('#'))
    );
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([
  ['class Example < receiver', '.call'],
  ['class Example < first', 'and second'],
  ['class << receiver', '&.call'],
])('keeps comments in the continued header of %s', (header, continuation) => {
  const source = `${header}\n# one\n# two\n${continuation}\n  # body\n  first\nend`;
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const declaration = tree.rootNode.firstNamedChild!;
    const headerValue = declaration.childForFieldName('superclass') ?? declaration.childForFieldName('value')!;
    expect(headerValue.descendantsOfType('comment').map(({ text }) => text)).toEqual(['# one', '# two']);
    const body = declaration.childForFieldName('body')!;
    expect(body.firstNamedChild!.text).toBe('# body');
    expect(body.firstNamedChild!.nextNamedSibling?.text).toBe('first');
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([1016, 1018])('preserves a %i-byte heredoc delimiter through continued interpolation comments', (length) => {
  const word = 'A'.repeat(length);
  const parser = new Parser().setLanguage(language);
  try {
    for (const expression of [
      'receiver\n  # c\n  # d\n  .call',
      'class Nested < receiver\n  # c\n  # d\n  .call\nend',
    ]) {
      const source = `x = <<~${word}\n  #{${expression}}\n${word}\nfoo\n`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
        expect(body.descendantsOfType('comment').map(({ text }) => text)).toEqual(['# c', '# d']);
        const end = body.descendantsOfType('heredoc_end')[0]!;
        expect(end.text).toBe(word);
        expect(end.endIndex).toBe(source.lastIndexOf(word) + word.length);
        expect(tree.rootNode.lastNamedChild!.text).toBe('foo');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each([
  ['def example', 'body_statement'],
  ['class Example', 'body_statement'],
  ['module Example', 'body_statement'],
  ['foo do', 'body_statement'],
  ['if ready', 'then'],
  ['def example\n  work\nrescue StandardError', 'rescue'],
] as const)('retains trailing comments inside %s', (header, ownerType) => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(comment) @trailing');
  try {
    for (const newline of ['\n', '\r\n']) {
      const source = `${header.replaceAll('\n', newline)}${newline}${ownerType === 'rescue' ? '' : `  first${newline}`}  # trailing${newline}end`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        const comment = tree.rootNode.descendantsOfType('comment')[0]!;
        expect(comment.parent!.type).toBe(ownerType);
        expect(comment.parent!.endIndex).toBe(comment.endIndex);
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([
          `# trailing${newline.slice(0, -1)}`,
        ]);
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test.each(['def a', 'class A', 'module A', 'foo do', 'class << f'])(
  'parses %s with comments before its last statement',
  (header) => {
    const parser = new Parser().setLanguage(language);
    const tree = parser.parse(`${header}\n  # doc\n  x; # note\n  d\nend`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);
