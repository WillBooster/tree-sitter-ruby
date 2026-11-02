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

test.each([
  'obj.sink %q abc ',
  'sink! %q abc ',
  'sink? %q abc ',
  'Foo %q abc ',
  'def f; super %q abc ; end',
  'def f; return %q abc ; end',
  'loop do; break %q abc ; end',
  'loop do; next %q abc ; end',
  'def f; yield %q abc ; end',
  'obj.sink %q abc  do end',
  'sink %q abc  do end',
  'if true; sink %q abc else 2 end',
  'if true; sink %q abc elsif false then 2 end',
  'begin; sink %q abc ensure 2 end',
  'case 1; when 1 then sink %q abc when 2 then 3 end',
  'case 1; in Integer then sink %q abc in String then 3 end',
])('keeps a whitespace literal in the argument list of %j', (source) => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError, source).toBe(false);
    const literals = tree.rootNode.descendantsOfType('string');
    expect(literals.map((node) => [node.parent!.type, node.text])).toEqual([['argument_list', '%q abc ']]);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('keeps a whitespace literal containing a spaced Unicode escape', () => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('sink %Q \\u{41 42} , 1\nfollowing\n')!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const literal = tree.rootNode.descendantsOfType('string')[0]!;
    expect([literal.parent!.type, literal.text]).toEqual(['argument_list', String.raw`%Q \u{41 42} `]);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([
  'value = [<<EOS, (sink %q head\nbody with spaces\nEOS\ntail )]\nfollowing\n',
  'value = [<<EOS, (sink %q head\\\nbody with spaces\nEOS\ntail )]\nfollowing\n',
])('keeps a whitespace literal whose body spans a queued heredoc in %j', (source) => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const literal = tree.rootNode.descendantsOfType('string').find((node) => node.text.startsWith('%q'))!;
    expect(literal.parent!.type).toBe('argument_list');
    expect(literal.descendantsOfType('heredoc_body')).toHaveLength(1);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['if!', 'end?', '(1)', ':a', ":'a'", ':"a"', ':+', '!a', '~a', '@a', '$a'])(
  'keeps modulo before the operand %s',
  (name) => {
    const parser = new Parser().setLanguage(language);
    const tree = parser.parse(`def f(left, q)\n  value = left %q + ${name}\nend\n`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('string')).toHaveLength(0);
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);

test('keeps modulo by r before an operand that is not a regex option', () => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('def f(left, r, right)\n  value = left %r + right\nend\n')!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('regex')).toHaveLength(0);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test('keeps modulo when a spaced percent literal would run to the end of input', () => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse('def f(left, q)\n  left %q +1\nend\n')!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('string')).toHaveLength(0);
  } finally {
    tree.delete();
    parser.delete();
  }
});
