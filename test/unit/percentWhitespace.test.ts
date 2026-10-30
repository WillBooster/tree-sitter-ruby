import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
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
  try {
    for (const delimiter of [' ', '\t', '\r']) {
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
        expect(tree.rootNode.lastNamedChild!.text).toBe('following');
      } finally {
        tree.delete();
      }
    }
  } finally {
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
      ['value = [<<EOS, (sink %Q head\nbody\nEOS\ntail#{1} )]\nfollowing', 1],
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
          source.includes('<<EOS') ? ['\nbody\nEOS'] : []
        );
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['q', 'Q', 'x', 's', 'r'])('keeps %%%s followed by a line break after a name as modulo', (kind) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const lineBreak of ['\n', '\r\n']) {
      const source = `value = sink %${kind}${lineBreak}abc${lineBreak}`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.namedChildren.map(({ type }) => type)).toEqual(['assignment', 'identifier']);
        const binary = tree.rootNode.firstNamedChild!.childForFieldName('right')!;
        expect(binary.type).toBe('binary');
        expect(binary.text).toBe(`sink %${kind}`);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['w', 'W', 'i', 'I'])('keeps %%%s followed by a space after a name as modulo', (kind) => {
  const parser = new Parser().setLanguage(language);
  const source = `puts n if n %${kind} == 1\nfollowing`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    expect(tree.rootNode.descendantsOfType('binary').map(({ text }) => text)).toEqual([
      `n %${kind} == 1`,
      `n %${kind}`,
    ]);
    expect(tree.rootNode.lastNamedChild!.text).toBe('following');
  } finally {
    tree.delete();
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
