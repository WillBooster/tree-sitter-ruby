import path from 'node:path';

import { Edit, Language, Parser, type Point, Query, type Tree } from '@willbooster/web-tree-sitter';
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
  'def example value',
  'def self.example',
  'class Example',
  'class Example < Parent',
  'class << self',
  'module Example',
])('owns leading comments in the body of %s', (header) => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(body_statement (comment) @body.comment)');
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
        expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual([
          `# leading${carriageReturn}`,
          `# second${carriageReturn}`,
          `# middle${carriageReturn}`,
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
    query.delete();
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

test.each(['\n', '\r\n'])('reparents leading comments after insertion and undo with %j', (newline) => {
  const parser = new Parser().setLanguage(language);
  const source = `def example${newline}  first${newline}end`;
  const insertion = `  # leading${newline}`;
  const startIndex = source.indexOf('  first');
  let tree = parser.parse(source)!;
  try {
    tree.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex,
        newEndIndex: startIndex + insertion.length,
        startPosition: { row: 1, column: 0 },
        oldEndPosition: { row: 1, column: 0 },
        newEndPosition: { row: 2, column: 0 },
      })
    );
    const changed = source.slice(0, startIndex) + insertion + source.slice(startIndex);
    tree = replaceTree(parser, tree, changed);
    const body = tree.rootNode.firstNamedChild!.childForFieldName('body')!;
    expect(body.firstNamedChild!.text).toBe(`# leading${newline.slice(0, -1)}`);
    expect(body.firstNamedChild!.nextNamedSibling?.text).toBe('first');
    tree.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex + insertion.length,
        newEndIndex: startIndex,
        startPosition: { row: 1, column: 0 },
        oldEndPosition: { row: 2, column: 0 },
        newEndPosition: { row: 1, column: 0 },
      })
    );
    tree = replaceTree(parser, tree, source);
    expect(tree.rootNode.firstNamedChild!.childForFieldName('body')!.namedChildren.map(({ text }) => text)).toEqual([
      'first',
    ]);
  } finally {
    tree.delete();
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

test.each(['operator', 'comment'] as const)('invalidates continuation comments after a %s edit and undo', (kind) => {
  const parser = new Parser().setLanguage(language);
  const source = 'receiver\n# one\n# two\n.call\nfollowing';
  const startIndex = source.indexOf(kind === 'operator' ? '.' : '# two');
  const removed = kind === 'operator' ? '.' : '';
  const inserted = kind === 'operator' ? '' : '# inserted\n';
  const changed = source.slice(0, startIndex) + inserted + source.slice(startIndex + removed.length);
  let tree = parser.parse(source)!;
  try {
    tree.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex + removed.length,
        newEndIndex: startIndex + inserted.length,
        startPosition: pointAt(source, startIndex),
        oldEndPosition: pointAt(source, startIndex + removed.length),
        newEndPosition: pointAt(changed, startIndex + inserted.length),
      })
    );
    tree = replaceTree(parser, tree, changed);
    if (kind === 'operator') {
      expect(tree.rootNode.namedChildren.map(({ type }) => type)).toEqual([
        'identifier',
        'comment',
        'comment',
        'identifier',
        'identifier',
      ]);
    } else {
      expect(tree.rootNode.firstNamedChild!.type).toBe('call');
      expect(tree.rootNode.firstNamedChild!.descendantsOfType('comment').map(({ text }) => text)).toEqual([
        '# one',
        '# inserted',
        '# two',
      ]);
    }
    tree.edit(
      new Edit({
        startIndex,
        oldEndIndex: startIndex + inserted.length,
        newEndIndex: startIndex + removed.length,
        startPosition: pointAt(changed, startIndex),
        oldEndPosition: pointAt(changed, startIndex + inserted.length),
        newEndPosition: pointAt(source, startIndex + removed.length),
      })
    );
    tree = replaceTree(parser, tree, source);
    expect(tree.rootNode.firstNamedChild!.type).toBe('call');
    expect(tree.rootNode.firstNamedChild!.descendantsOfType('comment').map(({ text }) => text)).toEqual([
      '# one',
      '# two',
    ]);
  } finally {
    tree.delete();
    parser.delete();
  }
});

function pointAt(source: string, index: number): Point {
  const prefix = source.slice(0, index);
  return { row: prefix.split('\n').length - 1, column: index - prefix.lastIndexOf('\n') - 1 };
}

function replaceTree(parser: Parser, previous: Tree, source: string): Tree {
  const incremental = parser.parse(source, previous)!;
  previous.delete();
  const fresh = parser.parse(source)!;
  try {
    expect(incremental.rootNode.hasError).toBe(false);
    expect(incremental.rootNode.toString()).toBe(fresh.rootNode.toString());
  } finally {
    fresh.delete();
  }
  return incremental;
}
