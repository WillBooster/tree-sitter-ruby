import path from 'node:path';
import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';
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

test.each([
  ['string', '"', '"'],
  ['word array', '%W[', ']'],
  ['symbol array', '%I[', ']'],
])('starts a pending heredoc after an included escaped newline across ranges in a %s', async (_, open, close) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const gap of ['', 'EXCLUDED']) {
        const prefix = `value = ${open}#{<<EOS} b\\${newline}`;
        const source = `${prefix}${gap}  body${newline}EOS${newline}c${close}\nfollowing = 1\n`;
        const position = (index: number): { row: number; column: number } => {
          const lines = source.slice(0, index).split('\n');
          return { row: lines.length - 1, column: lines.at(-1)!.length };
        };
        const tree = parser.parse(source, undefined, {
          includedRanges: [
            {
              startIndex: 0,
              endIndex: prefix.length,
              startPosition: position(0),
              endPosition: position(prefix.length),
            },
            {
              startIndex: prefix.length + gap.length,
              endIndex: source.length,
              startPosition: position(prefix.length + gap.length),
              endPosition: position(source.length),
            },
          ],
        })!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const outer = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
          const inner = outer.descendantsOfType('heredoc_content')[0]!;
          expect(outer.text).toBe(`  body${newline}EOS`);
          expect(inner.text).toBe(`  body${newline}`);
          expect(outer.startIndex).toBe(prefix.length + gap.length);
          expect(inner.startIndex).toBe(outer.startIndex);
          expect(outer.endIndex).toBe(source.indexOf(`${newline}EOS`) + newline.length + 3);
          expect(inner.endIndex).toBe(source.indexOf(`${newline}EOS`) + newline.length);
          expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
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

test.each(['%W', '%I'])('preserves a queued heredoc after trailing whitespace in %s', async (kind) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  try {
    for (const suffix of [
      ' ',
      '\t',
      '\f',
      '\v',
      ' b ',
      ' b\t',
      ' \f',
      '\v\t',
      ' b\f',
      ' b\v',
      '\r ',
      ' \r\f',
      '\r\v',
      ' b\r \t',
    ]) {
      for (const newline of ['\n', '\r\n']) {
        const source = `value = ${kind}[a #{<<EOS}${suffix}${newline}body${newline}EOS${newline}c]\nfollowing = 1\n`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          expect(
            tree.rootNode
              .descendantsOfType('heredoc_content')
              .map(({ text }) => text)
              .join('')
          ).toBe(`${newline}body${newline}`);
          const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
          expect(body.text).toBe(`${newline}body${newline}EOS`);
          expect(body.startIndex).toBe(source.indexOf('body') - newline.length);
          expect(body.endIndex).toBe(source.indexOf(`${newline}EOS`) + newline.length + 3);
          expect(tree.rootNode.descendantsOfType('heredoc_end').map(({ text }) => text)).toEqual(['EOS']);
          expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each([
  ['string', '"', '"'],
  ['percent string', '%Q[', ']'],
  ['word array', '%W[', ']'],
  ['symbol array', '%I[', ']'],
  ['subshell', '`', '`'],
  ['regexp', '/', '/'],
  ['quoted symbol', ':"', '"'],
])('keeps an escaped physical newline outside the queued heredoc in a %s', async (_, open, close) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const literal of [
        `${open}a #{<<EOS} b\\${newline}body${newline}EOS${newline}c${close}`,
        `[<<EOS, ${open}a\\${newline}body${newline}EOS${newline}c${close}]`,
      ]) {
        const source = `value = ${literal}\nfollowing = 1\n`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const content = tree.rootNode.descendantsOfType('heredoc_content');
          expect(content.map(({ text }) => text).join('')).toBe(`body${newline}`);
          expect(content[0]!.startIndex).toBe(source.indexOf('body'));
          expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['%W', '%I'])('keeps heredoc ranges when editing host whitespace in %s', async (kind) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      const prefix = `value = ${kind}[a #{<<EOS}`;
      const tail = `${newline}body${newline}EOS${newline}c]\nfollowing = 1\n`;
      let whitespace = ' \t';
      let tree = parser.parse(prefix + whitespace + tail)!;
      try {
        for (const replacement of ['\f\v', '\r \t', ' \t']) {
          const updated = prefix + replacement + tail;
          tree.edit(
            new Edit({
              startIndex: prefix.length,
              oldEndIndex: prefix.length + whitespace.length,
              newEndIndex: prefix.length + replacement.length,
              startPosition: { row: 0, column: prefix.length },
              oldEndPosition: { row: 0, column: prefix.length + whitespace.length },
              newEndPosition: { row: 0, column: prefix.length + replacement.length },
            })
          );
          const previous = tree;
          tree = parser.parse(updated, previous)!;
          previous.delete();
          const fresh = parser.parse(updated)!;
          try {
            expect(tree.rootNode.hasError).toBe(false);
            expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
            const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
            expect(body.text).toBe(`${newline}body${newline}EOS`);
            expect(body.startIndex).toBe(updated.indexOf('body') - newline.length);
            expect(body.endIndex).toBe(updated.indexOf(`${newline}EOS`) + newline.length + 3);
            expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
          } finally {
            fresh.delete();
          }
          whitespace = replacement;
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each([
  ['string', '"', '"'],
  ['single-quoted string', "'", "'"],
  ['word array', '%W[', ']'],
  ['non-interpolating word array', '%w[', ']'],
  ['symbol array', '%I[', ']'],
  ['non-interpolating symbol array', '%i[', ']'],
])('preserves physical line boundaries across included ranges in a %s', async (_, open, close) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  try {
    for (const [left, right] of [
      ['\r', '\n'],
      ['\\\r', '\n'],
      ['\\', '\r\n'],
      ['\\', '\n'],
    ] as const) {
      for (const gap of ['', 'EXCLUDED']) {
        const sibling = ["'", '%w[', '%i['].includes(open!);
        const prefix = sibling ? `value = [<<EOS, ${open}a${left}` : `value = ${open}a #{<<EOS} b${left}`;
        const source = `${prefix}${gap}${right}body\nEOS\nc${close}${sibling ? ']' : ''}\nfollowing = 1\n`;
        const position = (index: number): { row: number; column: number } => {
          const lines = source.slice(0, index).split('\n');
          return { row: lines.length - 1, column: lines.at(-1)!.length };
        };
        const tree = parser.parse(source, undefined, {
          includedRanges: [
            {
              startIndex: 0,
              endIndex: prefix.length,
              startPosition: position(0),
              endPosition: position(prefix.length),
            },
            {
              startIndex: prefix.length + gap.length,
              endIndex: source.length,
              startPosition: position(prefix.length + gap.length),
              endPosition: position(source.length),
            },
          ],
        })!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const ending = gap ? right : left.startsWith('\\') ? '' : '\r\n';
          const outer = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
          const inner = outer.descendantsOfType('heredoc_content')[0]!;
          expect(outer.text).toBe(`${ending}body\nEOS`);
          expect(inner.text).toBe(`${ending}body\n`);
          expect(outer.startIndex).toBe(source.indexOf('body') - ending.length);
          expect(inner.startIndex).toBe(outer.startIndex);
          expect(outer.endIndex).toBe(source.indexOf('\nEOS') + 4);
          expect(inner.endIndex).toBe(source.indexOf('\nEOS') + 1);
          for (const escape of tree.rootNode.descendantsOfType('escape_sequence')) {
            expect(escape.text).not.toContain('EXCLUDED');
          }
          expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each([
  ['string', '"', '"'],
  ['word array', '%W[', ']'],
  ['symbol array', '%I[', ']'],
])('preserves indented heredocs after escaped newlines in a %s', async (_, open, close) => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const indentation of ['  ', '\t', '\f', '\v']) {
        const prefix = `value = ${open}a #{<<EOS} b\\${newline}`;
        const suffix = `body${newline}EOS${newline}c${close}\nfollowing = 1\n`;
        let currentIndentation = indentation;
        let tree = parser.parse(prefix + currentIndentation + suffix)!;
        try {
          for (const replacement of [indentation, `${indentation} `, indentation]) {
            tree.edit(
              new Edit({
                startIndex: prefix.length,
                oldEndIndex: prefix.length + currentIndentation.length,
                newEndIndex: prefix.length + replacement.length,
                startPosition: { row: 1, column: 0 },
                oldEndPosition: { row: 1, column: currentIndentation.length },
                newEndPosition: { row: 1, column: replacement.length },
              })
            );
            const source = prefix + replacement + suffix;
            const previous = tree;
            tree = parser.parse(source, previous)!;
            previous.delete();
            const fresh = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
              for (const parsed of [tree, fresh]) {
                const outer = parsed.rootNode.descendantsOfType('heredoc_body')[0]!;
                const inner = outer.descendantsOfType('heredoc_content')[0]!;
                expect(outer.text).toBe(`${replacement}body${newline}EOS`);
                expect(inner.text).toBe(`${replacement}body${newline}`);
                expect(outer.startIndex).toBe(prefix.length);
                expect(inner.startIndex).toBe(prefix.length);
                expect(outer.endIndex).toBe(prefix.length + replacement.length + `body${newline}EOS`.length);
                expect(inner.endIndex).toBe(prefix.length + replacement.length + `body${newline}`.length);
                expect(parsed.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
              }
            } finally {
              fresh.delete();
            }
            currentIndentation = replacement;
          }
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['%W', '%w', '%I', '%i'])(
  'preserves heredocs after array separators and escaped newlines in %s',
  async (kind) => {
    await Parser.init();
    const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
    const parser = new Parser().setLanguage(language);
    const interpolated = kind === '%W' || kind === '%I';
    try {
      for (const separator of [' ', '\t', '\f', '\v', '\r', ' \t\f\v\r']) {
        for (const newline of ['\n', '\r\n']) {
          for (const gap of ['', 'EXCLUDED']) {
            const prefix = interpolated
              ? `value = ${kind}[a #{<<EOS} b${separator}\\${newline}`
              : `value = [<<EOS, ${kind}[a${separator}\\${newline}`;
            const source = `${prefix}${gap}\t  body${newline}EOS${newline}c]${interpolated ? '' : ']'}\nfollowing = 1\n`;
            const position = (index: number): { row: number; column: number } => {
              const lines = source.slice(0, index).split('\n');
              return { row: lines.length - 1, column: lines.at(-1)!.length };
            };
            const tree = parser.parse(source, undefined, {
              includedRanges: [
                {
                  startIndex: 0,
                  endIndex: prefix.length,
                  startPosition: position(0),
                  endPosition: position(prefix.length),
                },
                {
                  startIndex: prefix.length + gap.length,
                  endIndex: source.length,
                  startPosition: position(prefix.length + gap.length),
                  endPosition: position(source.length),
                },
              ],
            })!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              const outer = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
              const inner = outer.descendantsOfType('heredoc_content')[0]!;
              expect(outer.text).toBe(`\t  body${newline}EOS`);
              expect(inner.text).toBe(`\t  body${newline}`);
              expect(outer.startIndex).toBe(prefix.length + gap.length);
              expect(inner.startIndex).toBe(outer.startIndex);
              expect(outer.endIndex).toBe(source.indexOf(`${newline}EOS`) + newline.length + 3);
              expect(inner.endIndex).toBe(source.indexOf(`${newline}EOS`) + newline.length);
              expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
            } finally {
              tree.delete();
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  }
);
