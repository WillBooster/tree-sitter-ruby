import path from 'node:path';

import { Edit, Language, type ParseOptions, Parser } from '@willbooster/web-tree-sitter';
import { beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

let language: Language;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
});

test.each([
  ['parenthesized expression', 'value = (<<EOS', ')'],
  ['array element', 'value = [<<EOS,', '1]'],
  ['semicolon', 'value = <<EOS;', ''],
])('preserves an indented heredoc after a host continuation in a %s', (_, prefix, suffix) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const gap of ['', 'EXCLUDED']) {
        const beginning = `${prefix}\\${newline}`;
        let source = `${beginning}${gap}  body${newline}EOS${newline}${suffix}\nfollowing = 1\n`;
        const options = (text: string): ParseOptions => ({
          includedRanges: [
            {
              startIndex: 0,
              endIndex: beginning.length,
              startPosition: positionInText(text, 0),
              endPosition: positionInText(text, beginning.length),
            },
            {
              startIndex: beginning.length + gap.length,
              endIndex: text.length,
              startPosition: positionInText(text, beginning.length + gap.length),
              endPosition: positionInText(text, text.length),
            },
          ],
        });
        let tree = parser.parse(source, undefined, options(source))!;
        let previousContent = 'body';
        try {
          for (const content of ['body', 'longer', 'body']) {
            if (content !== previousContent) {
              const start = source.indexOf(previousContent, beginning.length);
              const updated = source.slice(0, start) + content + source.slice(start + previousContent.length);
              tree.edit(
                new Edit({
                  startIndex: start,
                  oldEndIndex: start + previousContent.length,
                  newEndIndex: start + content.length,
                  startPosition: positionInText(source, start),
                  oldEndPosition: positionInText(source, start + previousContent.length),
                  newEndPosition: positionInText(updated, start + content.length),
                })
              );
              const old = tree;
              tree = parser.parse(updated, old, options(updated))!;
              old.delete();
              source = updated;
              previousContent = content;
            }
            const fresh = parser.parse(source, undefined, options(source))!;
            try {
              expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
              for (const parsed of [tree, fresh]) {
                expect(parsed.rootNode.hasError, source).toBe(false);
                const bodies = parsed.rootNode.descendantsOfType('heredoc_body');
                const contents = parsed.rootNode.descendantsOfType('heredoc_content');
                expect(bodies.map(({ text }) => text)).toEqual([`  ${content}${newline}EOS`]);
                expect(contents.map(({ text }) => text)).toEqual([`  ${content}${newline}`]);
                expect(bodies[0]!.startIndex).toBe(beginning.length + gap.length);
                expect(contents[0]!.startIndex).toBe(beginning.length + gap.length);
                expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
              }
            } finally {
              fresh.delete();
            }
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

test.each([
  ['if true', 'if_modifier'],
  ['unless false', 'unless_modifier'],
  ['rescue nil', 'rescue_modifier'],
  ['+ "tail"', 'binary'],
])('resumes a continued heredoc host expression before %s', (suffix, kind) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      const prefix = `value = <<EOS \\${newline}`;
      let source = `${prefix}  body${newline}EOS${newline}  ${suffix}\nfollowing = 1\n`;
      let tree = parser.parse(source)!;
      let previous = 'body';
      try {
        for (const content of ['body', 'changed', 'body']) {
          if (content !== previous) {
            const start = source.indexOf(previous);
            const updated = source.slice(0, start) + content + source.slice(start + previous.length);
            tree.edit(
              new Edit({
                startIndex: start,
                oldEndIndex: start + previous.length,
                newEndIndex: start + content.length,
                startPosition: positionInText(source, start),
                oldEndPosition: positionInText(source, start + previous.length),
                newEndPosition: positionInText(updated, start + content.length),
              })
            );
            const old = tree;
            tree = parser.parse(updated, old)!;
            old.delete();
            source = updated;
            previous = content;
          }
          const fresh = parser.parse(source)!;
          try {
            expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
            for (const parsed of [tree, fresh]) {
              expect(parsed.rootNode.hasError, source).toBe(false);
              expect(parsed.rootNode.descendantsOfType(kind)).toHaveLength(1);
              const body = parsed.rootNode.descendantsOfType('heredoc_body')[0]!;
              const end = parsed.rootNode.descendantsOfType('heredoc_end')[0]!;
              expect(body.text).toBe(`  ${content}${newline}EOS`);
              expect(body.startIndex).toBe(prefix.length);
              expect(body.endIndex).toBe(prefix.length + 2 + content.length + newline.length + 3);
              expect(end.text).toBe('EOS');
              expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
            }
          } finally {
            fresh.delete();
          }
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['\n', '\r\n'])('keeps template statements separate at terminator range boundaries with %j', (newline) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const terminatorTail of [newline, ` \t ${newline}`]) {
      for (let boundary = 0; boundary <= terminatorTail.length; boundary++) {
        const gap = 'EXCLUDED';
        const prefix = `value = <<EOS \\${newline}  body${newline}EOS`;
        let source = `${prefix}${terminatorTail.slice(0, boundary)}${gap}${terminatorTail.slice(boundary)}if true\n inside = 1\nend\nfollowing = 1\n`;
        const options = (text: string): ParseOptions => {
          const start = text.indexOf(gap);
          return {
            includedRanges: [
              {
                startIndex: 0,
                endIndex: start,
                startPosition: positionInText(text, 0),
                endPosition: positionInText(text, start),
              },
              {
                startIndex: start + gap.length,
                endIndex: text.length,
                startPosition: positionInText(text, start + gap.length),
                endPosition: positionInText(text, text.length),
              },
            ],
          };
        };
        let tree = parser.parse(source, undefined, options(source))!;
        let previous = 'body';
        try {
          for (const content of ['body', 'changed', 'body']) {
            if (content !== previous) {
              const start = source.indexOf(previous);
              const updated = source.slice(0, start) + content + source.slice(start + previous.length);
              tree.edit(
                new Edit({
                  startIndex: start,
                  oldEndIndex: start + previous.length,
                  newEndIndex: start + content.length,
                  startPosition: positionInText(source, start),
                  oldEndPosition: positionInText(source, start + previous.length),
                  newEndPosition: positionInText(updated, start + content.length),
                })
              );
              const old = tree;
              tree = parser.parse(updated, old, options(updated))!;
              old.delete();
              source = updated;
              previous = content;
            }
            const fresh = parser.parse(source, undefined, options(source))!;
            try {
              expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
              for (const parsed of [tree, fresh]) {
                expect(parsed.rootNode.hasError, source).toBe(false);
                expect(parsed.rootNode.namedChildren.map(({ type }) => type)).toEqual([
                  'assignment',
                  'heredoc_body',
                  'if',
                  'assignment',
                ]);
                expect(parsed.rootNode.descendantsOfType('if_modifier')).toHaveLength(0);
                const body = parsed.rootNode.descendantsOfType('heredoc_body')[0]!;
                expect(body.text).toBe(`  ${content}${newline}EOS`);
                expect(body.startIndex).toBe(source.indexOf('  '));
                expect(body.endIndex).toBe(source.indexOf('EOS', body.startIndex) + 3);
                expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
              }
            } finally {
              fresh.delete();
            }
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

test.each(['\f', '\v'])('preserves statements after a heredoc label followed by %j', (whitespace) => {
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
])('preserves a heredoc and following statements inside a multiline %s', (_, literal) => {
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
])('starts a pending heredoc after an included escaped newline across ranges in a %s', (_, open, close) => {
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
])('starts a pending heredoc after an escaped newline in a %s', (_, open, close) => {
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

test.each(['%W', '%I'])('preserves a queued heredoc after trailing whitespace in %s', (kind) => {
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
])('keeps an escaped physical newline outside the queued heredoc in a %s', (_, open, close) => {
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

test.each(['%W', '%I'])('keeps heredoc ranges when editing host whitespace in %s', (kind) => {
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
])('preserves physical line boundaries across included ranges in a %s', (_, open, close) => {
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
])('preserves indented heredocs after escaped newlines in a %s', (_, open, close) => {
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

test.each(['%W', '%w', '%I', '%i'])('preserves heredocs after array separators and escaped newlines in %s', (kind) => {
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
});

test.each([
  ['opening', '%'],
  ['opening', '%Q'],
  ['opening', '%q'],
  ['opening', '%s'],
  ['opening', '%x'],
  ['opening', '%r'],
  ['closing', '%'],
  ['closing', '%Q'],
  ['closing', '%x'],
  ['closing', '%r'],
])('preserves heredocs across an %s newline delimiter in %s', (mode, kind) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const openEnding of ['\n', '\r\n']) {
      for (const closeEnding of ['\n', '\r\n']) {
        if (kind === '%r' && closeEnding === '\r\n') continue;
        for (const newline of ['\n', '\r\n']) {
          for (const gap of ['', 'EXCLUDED']) {
            for (const label of ['EOS', 'L'.repeat(300), '終'.repeat(100)]) {
              const content = mode === 'closing' && kind === '%r' ? 'im' : '  body';
              const raw = kind === '%q' || kind === '%s';
              const tail = raw ? 'tail#{literal}' : 'tail#{1}';
              const prefix =
                mode === 'opening'
                  ? `value = [<<${label}, ${kind}${openEnding}`
                  : `value = ${kind}${openEnding}#{<<${label}}${closeEnding}`;
              let source = `${prefix}${gap}${content}${newline}${label}${newline}${mode === 'opening' ? `${tail}${closeEnding}]\n` : ';\n'}following = 1\n`;
              const options = (text: string): ParseOptions => ({
                includedRanges: [
                  {
                    startIndex: 0,
                    endIndex: prefix.length,
                    startPosition: positionInText(text, 0),
                    endPosition: positionInText(text, prefix.length),
                  },
                  {
                    startIndex: prefix.length + gap.length,
                    endIndex: text.length,
                    startPosition: positionInText(text, prefix.length + gap.length),
                    endPosition: positionInText(text, text.length),
                  },
                ],
              });
              let tree = parser.parse(source, undefined, options(source))!;
              try {
                const bodyStart = prefix.length + gap.length;
                const tailStart = source.indexOf(tail, bodyStart);
                const changes = [
                  { start: bodyStart, old: content, replacement: content },
                  { start: bodyStart, old: content, replacement: `${content}x` },
                  { start: bodyStart, old: `${content}x`, replacement: content },
                  ...(mode === 'opening'
                    ? [
                        { start: tailStart, old: tail, replacement: `${tail}x` },
                        { start: tailStart, old: `${tail}x`, replacement: tail },
                      ]
                    : []),
                ];
                for (const { start, old, replacement } of changes) {
                  const oldEnd = start + old.length;
                  const updated = source.slice(0, start) + replacement + source.slice(oldEnd);
                  const expectedContent = start === bodyStart ? replacement : content;
                  const expectedTail = start === tailStart ? replacement : tail;
                  tree.edit(
                    new Edit({
                      startIndex: start,
                      oldEndIndex: oldEnd,
                      newEndIndex: start + replacement.length,
                      startPosition: positionInText(source, start),
                      oldEndPosition: positionInText(source, oldEnd),
                      newEndPosition: positionInText(updated, start + replacement.length),
                    })
                  );
                  const previous = tree;
                  tree = parser.parse(updated, previous, options(updated))!;
                  previous.delete();
                  source = updated;
                  const fresh = parser.parse(source, undefined, options(source))!;
                  try {
                    expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
                    for (const parsed of [tree, fresh]) {
                      expect(parsed.rootNode.hasError, source).toBe(false);
                      const outer = parsed.rootNode.descendantsOfType('heredoc_body')[0]!;
                      const inner = outer.descendantsOfType('heredoc_content')[0]!;
                      const end = source.indexOf(`${newline}${label}`, bodyStart) + newline.length;
                      expect(outer.text).toBe(`${expectedContent}${newline}${label}`);
                      expect(inner.text).toBe(`${expectedContent}${newline}`);
                      for (const node of [outer, inner]) {
                        expect(node.startIndex).toBe(bodyStart);
                        expect(node.startPosition).toEqual(positionInText(source, bodyStart));
                        const expectedEnd = node === outer ? end + label.length : end;
                        expect(node.endIndex).toBe(expectedEnd);
                        expect(node.endPosition).toEqual(positionInText(source, expectedEnd));
                      }
                      const literal = parsed.rootNode.firstNamedChild!.descendantsOfType([
                        'string',
                        'delimited_symbol',
                        'subshell',
                        'regex',
                      ])[0]!;
                      expect(literal.firstChild!.text).toBe(kind + openEnding);
                      const closing = literal.lastChild!;
                      expect(closing.text).toBe(closeEnding);
                      expect(closing.endIndex).toBe(
                        mode === 'closing' ? prefix.length : source.indexOf('\n]', end) + 1
                      );
                      if (mode === 'opening') {
                        expect(literal.text.endsWith(`${expectedTail}${closeEnding}`)).toBe(true);
                        expect(literal.descendantsOfType('interpolation')).toHaveLength(raw ? 0 : 1);
                      }
                      expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
                    }
                  } finally {
                    fresh.delete();
                  }
                }
              } finally {
                tree.delete();
              }
            }
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['%', '%Q', '%q', '%s', '%x', '%r'])('resumes an LF-delimited %s after all queued heredocs', (kind) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const count of [2, 3]) {
      for (const newline of ['\n', '\r\n']) {
        for (const gap of ['', 'EXCLUDED']) {
          for (const base of ['E', '終'.repeat(100)]) {
            const labels = Array.from({ length: count }, (_, index) => `${base}${index}`);
            const words = ['first', 'second', 'third'].slice(0, count);
            const raw = kind === '%q' || kind === '%s';
            const tail = raw ? 'tail#{literal}' : 'tail#{1}';
            const prefix = `value = [${labels.map((label) => `<<${label}`).join(', ')}, ${kind}\n`;
            let source = `${prefix}${gap}${words.map((word, index) => `${word}${newline}${labels[index]}${newline}`).join('')}${tail}\n]\nfollowing = 1\n`;
            const options = (text: string): ParseOptions => ({
              includedRanges: [
                {
                  startIndex: 0,
                  endIndex: prefix.length,
                  startPosition: positionInText(text, 0),
                  endPosition: positionInText(text, prefix.length),
                },
                {
                  startIndex: prefix.length + gap.length,
                  endIndex: text.length,
                  startPosition: positionInText(text, prefix.length + gap.length),
                  endPosition: positionInText(text, text.length),
                },
              ],
            });
            let tree = parser.parse(source, undefined, options(source))!;
            try {
              const lastWord = words.at(-1)!;
              const bodyStart = source.indexOf(lastWord, prefix.length);
              const tailStart = source.indexOf(tail, bodyStart);
              for (const { start, old, replacement } of [
                { start: bodyStart, old: lastWord, replacement: `${lastWord}x` },
                { start: bodyStart, old: `${lastWord}x`, replacement: lastWord },
                { start: tailStart, old: tail, replacement: `${tail}x` },
                { start: tailStart, old: `${tail}x`, replacement: tail },
              ]) {
                const updated = source.slice(0, start) + replacement + source.slice(start + old.length);
                tree.edit(
                  new Edit({
                    startIndex: start,
                    oldEndIndex: start + old.length,
                    newEndIndex: start + replacement.length,
                    startPosition: positionInText(source, start),
                    oldEndPosition: positionInText(source, start + old.length),
                    newEndPosition: positionInText(updated, start + replacement.length),
                  })
                );
                const previous = tree;
                tree = parser.parse(updated, previous, options(updated))!;
                previous.delete();
                source = updated;
                const fresh = parser.parse(source, undefined, options(source))!;
                try {
                  expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
                  for (const parsed of [tree, fresh]) {
                    expect(parsed.rootNode.hasError, source).toBe(false);
                    const outer = parsed.rootNode.descendantsOfType('heredoc_body');
                    const inner = parsed.rootNode.descendantsOfType('heredoc_content');
                    expect(outer).toHaveLength(count);
                    expect(inner).toHaveLength(count);
                    for (let index = 0; index < count; index++) {
                      const word = index === count - 1 && start === bodyStart ? replacement : words[index]!;
                      const content = `${index ? newline : ''}${word}${newline}`;
                      const bodyIndex = source.indexOf(word, prefix.length) - (index ? newline.length : 0);
                      expect(outer[index]!.text).toBe(content + labels[index]);
                      expect(inner[index]!.text).toBe(content);
                      expect(outer[index]!.startIndex).toBe(bodyIndex);
                      expect(inner[index]!.startIndex).toBe(bodyIndex);
                      expect(outer[index]!.endIndex).toBe(bodyIndex + content.length + labels[index]!.length);
                      expect(inner[index]!.endIndex).toBe(bodyIndex + content.length);
                    }
                    const literal = parsed.rootNode.firstNamedChild!.descendantsOfType([
                      'string',
                      'delimited_symbol',
                      'subshell',
                      'regex',
                    ])[0]!;
                    const expectedTail = start === tailStart ? replacement : tail;
                    expect(literal.text.endsWith(`${expectedTail}\n`)).toBe(true);
                    expect(literal.lastChild!.text).toBe('\n');
                    expect(literal.descendantsOfType('interpolation')).toHaveLength(raw ? 0 : 1);
                    expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
                  }
                } finally {
                  fresh.delete();
                }
              }
            } finally {
              tree.delete();
            }
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['%', '%Q', '%q', '%s', '%x', '%r'])(
  'preserves an LF-delimited %s when resumed content starts with interpolation or an escape',
  (kind) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const count of [1, 2]) {
        for (const newline of ['\n', '\r\n']) {
          for (const gap of ['', 'EXCLUDED']) {
            for (const tail of ['#{1}', String.raw`\n`, String.raw`\x41`]) {
              const labels = ['A', 'B'].slice(0, count);
              const prefix = `value = [${labels.map((label) => `<<${label}`).join(', ')}, ${kind}\n`;
              const bodies = labels.map((label, index) => `body${index}${newline}${label}${newline}`).join('');
              let source = `${prefix}${gap}${bodies}${tail}\n]\nfollowing = 1\n`;
              const options = (text: string): ParseOptions => ({
                includedRanges: [
                  {
                    startIndex: 0,
                    endIndex: prefix.length,
                    startPosition: positionInText(text, 0),
                    endPosition: positionInText(text, prefix.length),
                  },
                  {
                    startIndex: prefix.length + gap.length,
                    endIndex: text.length,
                    startPosition: positionInText(text, prefix.length + gap.length),
                    endPosition: positionInText(text, text.length),
                  },
                ],
              });
              let tree = parser.parse(source, undefined, options(source))!;
              let previousTail = tail;
              try {
                for (const replacement of [tail, `${tail}x`, tail]) {
                  const start = prefix.length + gap.length + bodies.length;
                  const updated = source.slice(0, start) + replacement + source.slice(start + previousTail.length);
                  tree.edit(
                    new Edit({
                      startIndex: start,
                      oldEndIndex: start + previousTail.length,
                      newEndIndex: start + replacement.length,
                      startPosition: positionInText(source, start),
                      oldEndPosition: positionInText(source, start + previousTail.length),
                      newEndPosition: positionInText(updated, start + replacement.length),
                    })
                  );
                  const previous = tree;
                  tree = parser.parse(updated, previous, options(updated))!;
                  previous.delete();
                  source = updated;
                  previousTail = replacement;
                  const fresh = parser.parse(source, undefined, options(source))!;
                  try {
                    expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
                    for (const parsed of [tree, fresh]) {
                      expect(parsed.rootNode.hasError, source).toBe(false);
                      const outer = parsed.rootNode.descendantsOfType('heredoc_body');
                      const inner = parsed.rootNode.descendantsOfType('heredoc_content');
                      expect(outer).toHaveLength(count);
                      for (let index = 0; index < count; index++) {
                        const content = `${index ? newline : ''}body${index}${newline}`;
                        const bodyStart = source.indexOf(`body${index}`) - (index ? newline.length : 0);
                        expect(outer[index]!.text).toBe(content + labels[index]);
                        expect(inner[index]!.text).toBe(content);
                        expect(outer[index]!.startIndex).toBe(bodyStart);
                        expect(inner[index]!.startIndex).toBe(bodyStart);
                        expect(outer[index]!.endIndex).toBe(bodyStart + content.length + 1);
                        expect(inner[index]!.endIndex).toBe(bodyStart + content.length);
                      }
                      const literal = parsed.rootNode.firstNamedChild!.descendantsOfType([
                        'string',
                        'delimited_symbol',
                        'subshell',
                        'regex',
                      ])[0]!;
                      expect(literal.text.endsWith(`${replacement}\n`)).toBe(true);
                      expect(literal.lastChild!.text).toBe('\n');
                      expect(literal.lastChild!.endIndex).toBe(source.lastIndexOf('\n]') + 1);
                      expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
                    }
                  } finally {
                    fresh.delete();
                  }
                }
              } finally {
                tree.delete();
              }
            }
          }
        }
      }
    } finally {
      parser.delete();
    }
  }
);

test.each(['opening', 'closing'])('keeps adjacent and disjoint CR/LF %s delimiters distinct', (mode) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const gap of ['', 'EXCLUDED']) {
      const prefix = mode === 'opening' ? 'value = [<<EOS, %Q\r' : 'value = %Q\n#{<<EOS}\r';
      const source = `${prefix}${gap}\nbody\nEOS\ntail${mode === 'opening' ? '\r\n]\n' : '\n;\n'}following = 1\n`;
      const tree = parser.parse(source, undefined, {
        includedRanges: [
          {
            startIndex: 0,
            endIndex: prefix.length,
            startPosition: positionInText(source, 0),
            endPosition: positionInText(source, prefix.length),
          },
          {
            startIndex: prefix.length + gap.length,
            endIndex: source.length,
            startPosition: positionInText(source, prefix.length + gap.length),
            endPosition: positionInText(source, source.length),
          },
        ],
      })!;
      try {
        const literal = tree.rootNode.descendantsOfType('string')[0]!;
        const body = tree.rootNode.descendantsOfType('heredoc_body')[0]!;
        if (mode === 'opening') {
          expect(literal.firstChild!.text).toBe(`%Q${gap ? '\r' : '\r\n'}`);
          expect(literal.firstChild!.endIndex).toBe(prefix.length + (gap ? 0 : 1));
          expect(body.text).toBe(`${gap ? '\n' : ''}body\nEOS`);
          expect(body.startIndex).toBe(prefix.length + gap.length + (gap ? 0 : 1));
        } else {
          expect(literal.lastChild!.text).toBe(gap ? '\n' : '\r\n');
          expect(literal.lastChild!.endIndex).toBe(prefix.length + gap.length + 1);
          expect(body.text).toBe('body\nEOS');
          expect(body.startIndex).toBe(prefix.length + gap.length + 1);
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['%', '%Q', '%q', '%s', '%x', '%r'])('preserves independent bare CR characters in %s', (kind) => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const literal of [`${kind}\rtail\r`, `[<<EOS, ${kind}\r\nbody\nEOS\na\rb\n]`]) {
      const source = `value = ${literal};\nfollowing = 1\n`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.namedChildren.at(-1)?.text).toBe('following = 1');
        const content = tree.rootNode.descendantsOfType('string_content');
        expect(content.map(({ text }) => text)).toContain(literal.includes('<<EOS') ? 'a\rb' : 'tail');
        if (!literal.includes('<<EOS')) {
          const node = tree.rootNode.firstNamedChild!.descendantsOfType([
            'string',
            'delimited_symbol',
            'subshell',
            'regex',
          ])[0]!;
          expect(node.firstChild!.text).toBe(`${kind}\r`);
          expect(node.lastChild!.text).toBe('\r');
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('keeps delimiter-like text after interpolation and escaped newlines in heredoc bodies', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      const ordinaryPrefix = `value = <<EOS`;
      const continuedPrefix = `value = <<EOS \\${newline}`;
      for (const fixture of [
        {
          source: `${ordinaryPrefix}${newline}#{y}EOS${newline}content${newline}EOS${newline}following = 1${newline}`,
          bodyStart: ordinaryPrefix.length,
          label: 'EOS',
          firstEnd: false,
        },
        {
          source: `${continuedPrefix}\\${newline}EOS${newline}content${newline}EOS${newline} if true${newline}following = 1${newline}`,
          bodyStart: continuedPrefix.length,
          label: 'EOS',
          firstEnd: false,
        },
        ...['#{x}', '#@x'].flatMap((label) =>
          ['', '~'].map((indent) => {
            const prefix = `value = <<${indent}"${label}"`;
            return {
              source: `${prefix}${newline}\\${newline}${label}${newline}content${newline}${label}${newline}following = 1${newline}`,
              bodyStart: prefix.length,
              label,
              firstEnd: indent === '',
            };
          })
        ),
      ]) {
        let source = fixture.source;
        let tree = parser.parse(source)!;
        let previous = 'content';
        try {
          for (const content of ['content', 'longer content', 'content']) {
            if (content !== previous) {
              const start = source.indexOf(previous);
              const updated = source.slice(0, start) + content + source.slice(start + previous.length);
              tree.edit(
                new Edit({
                  startIndex: start,
                  oldEndIndex: start + previous.length,
                  newEndIndex: start + content.length,
                  startPosition: positionInText(source, start),
                  oldEndPosition: positionInText(source, start + previous.length),
                  newEndPosition: positionInText(updated, start + content.length),
                })
              );
              const old = tree;
              tree = parser.parse(updated, old)!;
              old.delete();
              source = updated;
              previous = content;
            }
            const fresh = parser.parse(source)!;
            try {
              expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
              for (const parsed of [tree, fresh]) {
                expect(parsed.rootNode.hasError, source).toBe(false);
                const endStart = fixture.firstEnd
                  ? source.indexOf(fixture.label, fixture.bodyStart)
                  : source.lastIndexOf(fixture.label);
                const endIndex = endStart + fixture.label.length;
                const ends = parsed.rootNode.descendantsOfType('heredoc_end');
                expect(ends).toHaveLength(1);
                expect(ends[0]!.text).toBe(fixture.label);
                expect(ends[0]!.startIndex).toBe(endStart);
                expect(ends[0]!.endIndex).toBe(endIndex);
                const bodies = parsed.rootNode.descendantsOfType('heredoc_body');
                expect(bodies).toHaveLength(1);
                expect(bodies[0]!.text).toBe(source.slice(fixture.bodyStart, endIndex));
                expect(bodies[0]!.startPosition).toEqual(positionInText(source, fixture.bodyStart));
                expect(bodies[0]!.endPosition).toEqual(positionInText(source, endIndex));
                expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
              }
            } finally {
              fresh.delete();
            }
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

test('keeps ordinary hashes between heredoc interpolations as content', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const continued of [false, true]) {
        const prefix = `value = <<EOS${continued ? ` \\${newline}` : ''}`;
        const leadingNewline = continued ? '' : newline;
        let source = `${prefix}${leadingNewline}#{first}##{second}${newline}EOS${newline}${continued ? ` if true${newline}` : ''}following = 1${newline}`;
        let tree = parser.parse(source)!;
        let previous = '#';
        const hashStart = prefix.length + leadingNewline.length + '#{first}'.length;
        try {
          for (const hashes of ['#', '##', '#']) {
            if (hashes !== previous) {
              const updated = source.slice(0, hashStart) + hashes + source.slice(hashStart + previous.length);
              tree.edit(
                new Edit({
                  startIndex: hashStart,
                  oldEndIndex: hashStart + previous.length,
                  newEndIndex: hashStart + hashes.length,
                  startPosition: positionInText(source, hashStart),
                  oldEndPosition: positionInText(source, hashStart + previous.length),
                  newEndPosition: positionInText(updated, hashStart + hashes.length),
                })
              );
              const old = tree;
              tree = parser.parse(updated, old)!;
              old.delete();
              source = updated;
              previous = hashes;
            }
            const fresh = parser.parse(source)!;
            try {
              expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
              for (const parsed of [tree, fresh]) {
                expect(parsed.rootNode.hasError, source).toBe(false);
                const body = parsed.rootNode.descendantsOfType('heredoc_body')[0]!;
                expect(body.descendantsOfType('interpolation').map(({ text }) => text)).toEqual([
                  '#{first}',
                  '#{second}',
                ]);
                expect(body.descendantsOfType('comment')).toHaveLength(0);
                expect(
                  body
                    .descendantsOfType('heredoc_content')
                    .map(({ text }) => text)
                    .join('')
                ).toBe(`${leadingNewline}${hashes}${newline}`);
                const endStart = source.lastIndexOf('EOS');
                const end = body.descendantsOfType('heredoc_end')[0]!;
                expect(end.startIndex).toBe(endStart);
                expect(end.endIndex).toBe(endStart + 3);
                expect(body.text).toBe(source.slice(prefix.length, endStart + 3));
                expect(body.startPosition).toEqual(positionInText(source, prefix.length));
                expect(body.endPosition).toEqual(positionInText(source, endStart + 3));
                expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
              }
            } finally {
              fresh.delete();
            }
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

test('keeps nested heredoc bodies inside their owning body', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const multiline of [false, true]) {
        for (const inner of ['INNER', 'OUT']) {
          const interpolation = multiline ? `#{${newline}  <<${inner}` : `#{<<${inner}}`;
          let source = `value = <<OUT${newline}before ${interpolation}${newline}inner text${newline}${inner}${newline}${multiline ? `}${newline}` : ''}after${newline}OUT${newline}following = 1${newline}`;
          let tree = parser.parse(source)!;
          let previous = 'inner text';
          try {
            for (const content of ['inner text', 'changed inner text', 'inner text']) {
              if (content !== previous) {
                const start = source.indexOf(previous);
                const updated = source.slice(0, start) + content + source.slice(start + previous.length);
                tree.edit(
                  new Edit({
                    startIndex: start,
                    oldEndIndex: start + previous.length,
                    newEndIndex: start + content.length,
                    startPosition: positionInText(source, start),
                    oldEndPosition: positionInText(source, start + previous.length),
                    newEndPosition: positionInText(updated, start + content.length),
                  })
                );
                const old = tree;
                tree = parser.parse(updated, old)!;
                old.delete();
                source = updated;
                previous = content;
              }
              const fresh = parser.parse(source)!;
              try {
                expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
                for (const parsed of [tree, fresh]) {
                  expect(parsed.rootNode.hasError, source).toBe(false);
                  const bodies = parsed.rootNode.descendantsOfType('heredoc_body');
                  expect(bodies).toHaveLength(2);
                  const outer = bodies[0]!;
                  const nested = bodies[1]!;
                  let owner = nested.parent;
                  while (owner && owner.type !== 'heredoc_body') owner = owner.parent;
                  expect(owner?.id).toBe(outer.id);
                  const innerStart = source.indexOf(`${newline}${inner}${newline}`) + newline.length;
                  const outerStart = source.lastIndexOf(`${newline}OUT${newline}`) + newline.length;
                  for (const [body, start, label] of [
                    [nested, innerStart, inner],
                    [outer, outerStart, 'OUT'],
                  ] as const) {
                    const end = body.namedChildren.find((node) => node.type === 'heredoc_end')!;
                    expect(end.text).toBe(label);
                    expect(end.startIndex).toBe(start);
                    expect(end.endIndex).toBe(start + label.length);
                    expect(body.endPosition).toEqual(positionInText(source, start + label.length));
                  }
                  expect(nested.text).toContain(content);
                  expect(outer.text).toContain(`after${newline}OUT`);
                  expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
                }
              } finally {
                fresh.delete();
              }
            }
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test('resumes a nested continued heredoc host before its outer body', () => {
  const parser = new Parser().setLanguage(language);
  try {
    for (const newline of ['\n', '\r\n']) {
      for (const outerContinued of [false, true]) {
        for (const queued of [false, true]) {
          const beginning = queued ? '[<<FIRST, <<INNER]' : '<<INNER';
          const content = queued ? `first${newline}FIRST${newline}inner${newline}INNER` : `inner${newline}INNER`;
          const source = `value = <<OUT${outerContinued ? ` \\${newline}` : newline}before #{${newline}  nested = ${beginning} \\${newline}${content}${newline} + "suffix"${newline}}${newline}after${newline}OUT${newline}${outerContinued ? ` if true${newline}` : ''}following = 1${newline}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            expect(tree.rootNode.lastNamedChild?.text).toBe('following = 1');
            const assignment = tree.rootNode
              .descendantsOfType('assignment')
              .find((node) => node.childForFieldName('left')?.text === 'nested')!;
            const value = assignment.childForFieldName('right')!;
            expect(value.type).toBe('binary');
            expect(value.childForFieldName('left')?.type).toBe(queued ? 'array' : 'heredoc_beginning');
            expect(value.childForFieldName('operator')?.text).toBe('+');
            expect(value.childForFieldName('right')?.text).toBe('"suffix"');
            expect(tree.rootNode.descendantsOfType('if_modifier')).toHaveLength(outerContinued ? 1 : 0);
            const bodies = tree.rootNode.descendantsOfType('heredoc_body');
            expect(bodies).toHaveLength(queued ? 3 : 2);
            const outer = bodies.find((body) =>
              body.namedChildren.some((node) => node.type === 'heredoc_end' && node.text === 'OUT')
            )!;
            for (const body of bodies.filter((node) => node.id !== outer.id)) {
              let owner = body.parent;
              while (owner && owner.type !== 'heredoc_body') owner = owner.parent;
              expect(owner?.id).toBe(outer.id);
            }
          } finally {
            tree.delete();
          }
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test.each(['%', '%Q', '%q', '%s', '%x', '%r'])(
  'resumes an LF-delimited %s before its suspended heredoc owner',
  (kind) => {
    const parser = new Parser().setLanguage(language);
    try {
      for (const newline of ['\n', '\r\n']) {
        for (const queued of [false, true]) {
          for (const depth of [1, 2]) {
            const labels = queued ? ['FIRST', 'INNER'] : ['INNER'];
            const bodies = labels.map((label) => `body ${label}${newline}${label}${newline}`).join('');
            const host = `[${labels.map((label) => `<<${label}`).join(', ')}, ${kind}\n${bodies}tail\n]`;
            const middle = depth === 1 ? host : `<<MIDDLE}\nmiddle #{${host}}\nMIDDLE\n`;
            let source = `value = <<OUT\nbefore #{${middle}${depth === 1 ? '}\n' : ''}after\nOUT\nfollowing = 1\n`;
            let tree = parser.parse(source)!;
            let previousTail = 'tail';
            try {
              for (const tail of ['tail', 'tailx', 'tail']) {
                const start = source.indexOf(previousTail);
                const updated = source.slice(0, start) + tail + source.slice(start + previousTail.length);
                tree.edit(
                  new Edit({
                    startIndex: start,
                    oldEndIndex: start + previousTail.length,
                    newEndIndex: start + tail.length,
                    startPosition: positionInText(source, start),
                    oldEndPosition: positionInText(source, start + previousTail.length),
                    newEndPosition: positionInText(updated, start + tail.length),
                  })
                );
                const previous = tree;
                tree = parser.parse(updated, previous)!;
                previous.delete();
                source = updated;
                previousTail = tail;
                const fresh = parser.parse(source)!;
                try {
                  expect(tree.rootNode.toString()).toBe(fresh.rootNode.toString());
                  for (const parsed of [tree, fresh]) {
                    expect(parsed.rootNode.hasError, source).toBe(false);
                    const literal = parsed.rootNode.descendantsOfType([
                      'string',
                      'delimited_symbol',
                      'subshell',
                      'regex',
                    ])[0]!;
                    expect(literal.text).toBe(`${kind}\n${bodies}${tail}\n`);
                    expect(literal.lastChild!.text).toBe('\n');
                    expect(literal.lastChild!.startIndex).toBe(source.indexOf(`${tail}\n`) + tail.length);
                    const heredocs = parsed.rootNode.descendantsOfType('heredoc_body');
                    expect(heredocs).toHaveLength(depth + labels.length);
                    for (const label of labels) {
                      const body = heredocs.find((node) => node.namedChildren.some((child) => child.text === label))!;
                      let owner = body.parent;
                      while (owner && owner.type !== 'heredoc_body') owner = owner.parent;
                      expect(owner?.lastNamedChild?.text).toBe(depth === 1 ? 'OUT' : 'MIDDLE');
                    }
                    expect(parsed.rootNode.lastNamedChild?.text).toBe('following = 1');
                  }
                } finally {
                  fresh.delete();
                }
              }
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

function positionInText(text: string, index: number): { row: number; column: number } {
  const lines = text.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1)!.length };
}
