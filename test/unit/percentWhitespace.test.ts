import path from 'node:path';

import { Edit, Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

let language: Language;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
});

test.each([
  ['q', 'string'],
  ['Q', 'string'],
  ['x', 'subshell'],
  ['s', 'delimited_symbol'],
  ['r', 'regex'],
])('keeps whitespace-delimited %%%s in command arguments', (kind, type) => {
  const parser = new Parser().setLanguage(language);
  const query = new Query(language, '(call receiver: [(string) (regex) (subshell) (delimited_symbol)] @literal)');
  try {
    for (const delimiter of kind === 'r' ? [' ', '\t', '\n', '\r'] : [' ', '\t', '\n', '\r', '\r\n']) {
      const literal = `%${kind}${delimiter}abc${delimiter}`;
      const source = `sink ${literal}.size, 7\nfollowing`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const call = tree.rootNode.firstNamedChild!;
        expect(call.type).toBe('call');
        const argumentsNode = call.childForFieldName('arguments')!;
        expect(argumentsNode.namedChildren.map(({ type: nodeType }) => nodeType)).toEqual(['call', 'integer']);
        const node = argumentsNode.firstNamedChild!.childForFieldName('receiver')!;
        expect(node.type).toBe(type);
        expect(node.text).toBe(literal);
        expect(node.startIndex).toBe(source.indexOf('%'));
        expect(node.endIndex).toBe(source.indexOf('.size'));
        expect(node.firstChild!.text).toBe(`%${kind}${delimiter}`);
        expect(node.lastChild!.text).toBe(delimiter);
        expect(query.captures(tree.rootNode).map(({ node: capture }) => capture.text)).toEqual([literal]);
        expect(tree.rootNode.lastNamedChild!.text).toBe('following');
      } finally {
        tree.delete();
      }
    }
  } finally {
    query.delete();
    parser.delete();
  }
});

test('reparses a typed whitespace literal after changing assignment to command and undoing', () => {
  const parser = new Parser().setLanguage(language);
  let source = 'value = %q abc \nfollowing';
  let prefix = 'value =';
  let tree = parser.parse(source)!;
  try {
    for (const replacement of ['sink', 'value =']) {
      const changed = replacement + source.slice(prefix.length);
      tree.edit(
        new Edit({
          startIndex: 0,
          oldEndIndex: prefix.length,
          newEndIndex: replacement.length,
          startPosition: { row: 0, column: 0 },
          oldEndPosition: { row: 0, column: prefix.length },
          newEndPosition: { row: 0, column: replacement.length },
        })
      );
      const previous = tree;
      tree = parser.parse(changed, previous)!;
      previous.delete();
      const fresh = parser.parse(changed)!;
      try {
        expect(tree.rootNode.hasError, changed).toBe(false);
        expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
        expect(tree.rootNode.descendantsOfType('string').map(({ text }) => text)).toEqual(['%q abc ']);
        expect(tree.rootNode.lastNamedChild!.text).toBe('following');
      } finally {
        fresh.delete();
      }
      source = changed;
      prefix = replacement;
    }
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('preserves interpolation and queued heredocs inside typed command literals', () => {
  const parser = new Parser().setLanguage(language);
  try {
    const sources: Array<[string, number]> = [
      ['sink %q abc#{1} , 7\nfollowing', 0],
      ['sink %Q abc#{1} , 7\nfollowing', 1],
      ['sink %s abc#{1} , 7\nfollowing', 0],
      ['sink %x abc#{1} , 7\nfollowing', 1],
      ['sink %r abc#{1} , 7\nfollowing', 1],
      ['value = [<<EOS, (sink %Q\nbody\nEOS\ntail#{1}\n)]\nfollowing', 1],
    ];
    for (const [source, interpolations] of sources) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('interpolation').map(({ text }) => text)).toEqual(
          Array.from({ length: interpolations }, () => '#{1}')
        );
        expect(tree.rootNode.lastNamedChild!.text).toBe('following');
        expect(tree.rootNode.descendantsOfType('heredoc_body').map(({ text }) => text)).toEqual(
          source.includes('<<EOS') ? ['body\nEOS'] : []
        );
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['w', 'W', 'i', 'I'])('does not terminate a whitespace-delimited %%%s list at word separators', (kind) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const delimiter of [' ', '\t', '\n', '\r\n']) {
      const source = `sink %${kind}${delimiter}abc${delimiter}.size, 7\nfollowing`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(true);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['sink%q abc ', 'sink %r\r\nabc\r\n.size, 7\nfollowing'])('retains syntax errors for %j', (source) => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(true);
  } finally {
    tree.delete();
    parser.delete();
  }
});
