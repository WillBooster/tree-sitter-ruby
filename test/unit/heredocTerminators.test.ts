import path from 'node:path';

import { Language, Parser, type Tree } from '@willbooster/web-tree-sitter';
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
] as const)('keeps blank-suffixed %s terminators in the body', (_, opening, indentation, interpolates) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const suffix of [' ', '\t', ' \t ']) {
        const header = `value = ${opening}`;
        const source = `${header}${newline}${indentation}EOS${suffix}${newline}#{value}${newline}${indentation}EOS${newline}following = 1`;
        const tree = parser.parse(source)!;
        try {
          expectHeredoc(tree, source, header.length, source.lastIndexOf('EOS'), interpolates ? ['#{value}'] : []);
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

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

test.each([
  '#{name}',
  '#@name',
  '#$name',
  '#@@name',
  '#$-x',
  '#@言',
  '#$言',
  'A#{name}',
  '言#{name}',
  'A#@name',
  'A#$name',
  'A#@@name',
  'A#$-x',
  'A#@言',
  'A#$言',
])('preserves interpolation in a blank-suffixed delimiter-shaped line: %s', (label) => {
  const parser = new Parser().setLanguage(language);
  const interpolations = ['#{value}', '#@other', '#$other', '#@@other', '#$-y'];
  const source = `value = <<"${label}"\n${label} \n${interpolations.join('\n')}\n#@1 #plain\n${label}\nfollowing = 1`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
    expect(body.descendantsOfType('interpolation').map(({ text }) => text)).toEqual([
      label.slice(label.indexOf('#')),
      ...interpolations,
    ]);
    const end = body.descendantsOfType('heredoc_end')[0]!;
    expect(end.text).toBe(label);
    expect(end.startIndex).toBe(source.lastIndexOf(label));
    expect(body.text).toBe(source.slice(source.indexOf('\n'), source.lastIndexOf(label) + label.length));
    expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each([String.raw`\n`, String.raw`A\n`, String.raw`言\n`])(
  'preserves escapes in a blank-suffixed delimiter-shaped line: %s',
  (label) => {
    const parser = new Parser().setLanguage(language);
    const source = `value = <<"${label}"\n${label} \n${label}\nfollowing = 1`;
    const tree = parser.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
      expect(body.descendantsOfType('escape_sequence').map(({ text }) => text)).toEqual([String.raw`\n`]);
      expect(body.descendantsOfType('heredoc_end').map(({ text }) => text)).toEqual([label]);
      expect(body.text).toBe(source.slice(source.indexOf('\n'), source.lastIndexOf(label) + label.length));
      expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
    } finally {
      tree.delete();
      parser.delete();
    }
  }
);

test.each(['\n', '\r\n'])('retains interior token ranges in heredocs with %j', (newline) => {
  const parser = new Parser().setLanguage(language);
  const label = String.raw`A#{name}\n`;
  const header = `value = <<"${label}"`;
  const source = `${header}${newline}${label} ${newline}${label}${newline}following = 1`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
    const interpolations = body.descendantsOfType('interpolation');
    const escapes = body.descendantsOfType('escape_sequence');
    expect(interpolations.map(({ text }) => text)).toEqual(['#{name}']);
    expect(escapes.map(({ text }) => text)).toEqual([String.raw`\n`]);
    expect(interpolations[0]!.startIndex).toBe(source.indexOf('#{', header.length));
    expect(escapes[0]!.startIndex).toBe(interpolations[0]!.endIndex);
    const end = body.descendantsOfType('heredoc_end')[0]!;
    expect(end.text).toBe(label);
    expect(end.startIndex).toBe(source.lastIndexOf(label));
    expect(body.text).toBe(source.slice(header.length, end.endIndex));
    expect(body.endPosition).toEqual(positionAt(source, end.endIndex));
    expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['<<"\0x\n', 'value = <<"\0x"\nbody\n'])(
  'finishes malformed NUL-prefixed heredocs within a progress budget: %j',
  (source) => {
    const parser = new Parser().setLanguage(language);
    let progressChecks = 0;
    let tree: Tree | undefined;
    try {
      tree =
        parser.parse(source, undefined, {
          progressCallback: () => {
            if (++progressChecks > 100) throw new Error('Parsing the short malformed heredoc did not finish');
          },
        }) ?? undefined;
      expect(tree).toBeTruthy();
      expect(tree!.rootNode.endIndex).toBe(source.length);
    } finally {
      tree?.delete();
      parser.delete();
    }
  }
);

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
