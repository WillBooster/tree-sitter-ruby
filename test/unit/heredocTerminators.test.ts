import path from 'node:path';

import { Edit, Language, Parser, type Tree } from '@willbooster/web-tree-sitter';
import { beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

let language: Language;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
});

test.each([
  ['plain', '<<EOS', '', true],
  ['indented', '<<-EOS', ' \t', true],
  ['squiggly', '<<~EOS', '  ', true],
  ['single quoted', "<<'EOS'", '', false],
  ['double quoted', '<<"EOS"', '', true],
  ['command', '<<`EOS`', '', true],
] as const)(
  'keeps blank-suffixed %s terminators in the body through edits',
  (_, opening, indentation, interpolates) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const newline of ['\n', '\r\n']) {
        for (const suffix of [' ', '\t', ' \t ']) {
          const header = `value = ${opening}`;
          const source = `${header}${newline}${indentation}EOS${suffix}${newline}#{value}${newline}${indentation}EOS${newline}following = 1`;
          checkTerminatorEdits(parser, source, header.length, suffix, interpolates);
        }
      }
    } finally {
      parser.delete();
    }
  }
);

test.each(['\n', '\r\n'])('closes an exact terminator at EOF with %j', (newline) => {
  const parser = new Parser().setLanguage(language);
  const source = `value = <<EOS${newline}body${newline}EOS`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
    const end = body.descendantsOfType('heredoc_end')[0]!;
    expect(end.text).toBe('EOS');
    expect(end.startIndex).toBe(source.length - 3);
    expect(end.endIndex).toBe(source.length);
    expect(
      body
        .descendantsOfType('heredoc_content')
        .map(({ text }) => text)
        .join('')
    ).toBe(`${newline}body${newline}`);
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['\n', '\r\n'])('keeps blank-suffixed delimiter text at EOF in the body with %j', (newline) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const suffix of [' ', '\t', ' \t ']) {
      const source = `value = <<EOS${newline}body${newline}EOS${suffix}`;
      const tree = parser.parse(source)!;
      try {
        const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
        expect(body.descendantsOfType('heredoc_end').map(({ text }) => text)).toEqual(['']);
        expect(
          body
            .descendantsOfType('heredoc_content')
            .map(({ text }) => text)
            .join('')
        ).toBe(`${newline}body${newline}EOS${suffix}`);
        expect(body.endIndex).toBe(source.length);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['#{name}', '#@name', '#$name', '#@@name', '#$-x', '#@言', '#$言'])(
  'preserves interpolation in a blank-suffixed delimiter-shaped line: %s',
  (label) => {
    const parser = new Parser().setLanguage(language);
    const interpolations = ['#{value}', '#@other', '#$other', '#@@other', '#$-y'];
    const source = `value = <<"${label}"\n${label} \n${interpolations.join('\n')}\n#@1 #plain\n${label}\nfollowing = 1`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
      expect(body.descendantsOfType('interpolation').map(({ text }) => text)).toEqual([label, ...interpolations]);
      const end = body.descendantsOfType('heredoc_end')[0]!;
      expect(end.text).toBe(label);
      expect(end.startIndex).toBe(source.lastIndexOf(label));
      expect(body.text).toBe(source.slice(source.indexOf('\n'), source.lastIndexOf(label) + label.length));
      expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);

test('preserves escapes in a blank-suffixed delimiter-shaped line', () => {
  const parser = new Parser().setLanguage(language);
  const source = 'value = <<"\\n"\n\\n \n\\n\nfollowing = 1';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
    expect(body.descendantsOfType('escape_sequence').map(({ text }) => text)).toEqual([String.raw`\n`]);
    expect(body.descendantsOfType('heredoc_end').map(({ text }) => text)).toEqual([String.raw`\n`]);
    expect(body.text).toBe(source.slice(source.indexOf('\n'), source.lastIndexOf(String.raw`\n`) + 2));
    expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
  } finally {
    tree.delete();
    parser.delete();
  }
});

function checkTerminatorEdits(
  parser: Parser,
  source: string,
  bodyStart: number,
  suffix: string,
  interpolates: boolean
): void {
  let tree = parser.parse(source)!;
  let previous = suffix;
  try {
    for (const tail of [suffix, '', suffix]) {
      if (tail !== previous) {
        const start = source.indexOf('EOS', bodyStart) + 3;
        const updated = source.slice(0, start) + tail + source.slice(start + previous.length);
        tree.edit(
          new Edit({
            startIndex: start,
            oldEndIndex: start + previous.length,
            newEndIndex: start + tail.length,
            startPosition: positionAt(source, start),
            oldEndPosition: positionAt(source, start + previous.length),
            newEndPosition: positionAt(updated, start + tail.length),
          })
        );
        const old = tree;
        tree = parser.parse(updated, old)!;
        old.delete();
        source = updated;
        previous = tail;
      }
      const fresh = parser.parse(source)!;
      try {
        expect(tree.rootNode.toString(), source).toBe(fresh.rootNode.toString());
        const endStart = tail === '' ? source.indexOf('EOS', bodyStart) : source.lastIndexOf('EOS');
        const interpolations = interpolates && tail !== '' ? ['#{value}'] : [];
        for (const parsed of [tree, fresh]) expectHeredoc(parsed, source, bodyStart, endStart, interpolations);
      } finally {
        fresh.delete();
      }
    }
  } finally {
    tree.delete();
  }
}

function expectHeredoc(
  tree: Tree,
  source: string,
  bodyStart: number,
  endStart: number,
  interpolations: string[]
): void {
  expect(tree.rootNode.hasError, source).toBe(false);
  const bodies = tree.rootNode.descendantsOfType('heredoc_body');
  expect(bodies).toHaveLength(1);
  const body = bodies[0]!;
  const end = body.descendantsOfType('heredoc_end')[0]!;
  expect(end.text).toBe('EOS');
  expect(end.startIndex).toBe(endStart);
  expect(end.endIndex).toBe(endStart + 3);
  expect(body.text).toBe(source.slice(bodyStart, endStart + 3));
  expect(body.startPosition).toEqual(positionAt(source, bodyStart));
  expect(body.endPosition).toEqual(positionAt(source, endStart + 3));
  expect(body.descendantsOfType('interpolation').map(({ text }) => text)).toEqual(interpolations);
  expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
}

function positionAt(source: string, index: number): { row: number; column: number } {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}
