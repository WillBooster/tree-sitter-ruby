import path from 'node:path';
import { Edit, Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

test('parses command operator assignments under yield negation and retains outer block ownership', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const expression of [
      'yield not x += foo y',
      'yield not x.y ||= foo bar',
      'yield not x[0] += foo y',
      'yield not x += y += foo z',
      'yield not x += y = foo z',
      'yield not x += not foo y',
      'yield not x += y = foo q, z',
      'foo yield not x += y = bar y do end',
      'yield not x += foo y rescue z',
      'foo yield not x += bar y do end',
    ]) {
      const source = `def f; ${expression}; end`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const negation = tree.rootNode
          .descendantsOfType('unary')
          .find((node) => node.childForFieldName('operator')?.text === 'not');
        expect(negation?.childForFieldName('operand')?.type, source).toBe('operator_assignment');
        if (expression === 'yield not x += foo y rescue z') {
          const right = negation?.childForFieldName('operand')?.childForFieldName('right');
          expect(right?.type, source).toBe('rescue_modifier');
          expect(right?.childForFieldName('body')?.text, source).toBe('foo y');
        }
        if (expression.startsWith('foo ')) {
          const calls = tree.rootNode.descendantsOfType('call');
          expect(
            calls.find((node) => node.childForFieldName('method')?.text === 'foo')?.childForFieldName('block')?.text
          ).toBe('do end');
          expect(
            calls.find((node) => node.childForFieldName('method')?.text === 'bar')?.childForFieldName('block')
          ).toBeNull();
        }
      } finally {
        tree.delete();
      }
    }
    for (const expression of ['yield x += foo y', 'yield not x += foo y do end']) {
      const tree = parser.parse(`def f; ${expression}; end`)!;
      try {
        expect(tree.rootNode.hasError, expression).toBe(true);
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('negates chained setter assignments with ordinary values without accepting command or multiple RHS forms', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const source of ['not a b do end.c = 1', 'not a b do end.c[0] = 1', 'not a b do end.c = 1 rescue d']) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        expect(tree.rootNode.descendantsOfType('unary')[0]?.childForFieldName('operand')?.type, source).toBe(
          'assignment'
        );
      } finally {
        tree.delete();
      }
    }
    for (const source of ['not x = a b', 'not a b do end.c = d e', 'not a b do end.c, x = 1']) {
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

test('bang negation owns completed-command assignments with ordinary right sides', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const operator of ['=', '+=', '||=']) {
      for (const prefix of ['!', 'not !']) {
        for (const suffix of prefix === '!'
          ? ['', ' rescue d', ' in Integer', ' => v']
          : ['', ' rescue d', ' in Integer']) {
          const source = `${prefix} a b do end.c ${operator} 1${suffix}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const bang = tree.rootNode
              .descendantsOfType('unary')
              .find((node) => node.childForFieldName('operator')?.text === '!');
            expect(bang?.childForFieldName('operand')?.type, source).toBe(
              operator === '=' ? 'assignment' : 'operator_assignment'
            );
            expect(bang?.childForFieldName('operand')?.childForFieldName('right')?.text, source).toBe(
              suffix === ' rescue d' ? '1 rescue d' : '1'
            );
          } finally {
            tree.delete();
          }
        }
      }
    }
    for (const source of [
      '! a b do end.c = d e',
      '! a b do end.c += d e',
      '! a b do end.c, x = 1',
      '!! a b do end.c = 1',
      '! x = d e',
    ]) {
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

test('yield retains signed super arguments and the enclosing call block', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const expression of ['yield super +x', 'yield super +x, y', 'yield super -x', 'foo yield super +x do end']) {
      const source = `def f; ${expression}; end`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const superCall = tree.rootNode
          .descendantsOfType('call')
          .find((node) => node.childForFieldName('method')?.type === 'super');
        expect(superCall?.childForFieldName('arguments')?.namedChildren[0]?.type, source).toBe('unary');
        if (expression.startsWith('foo ')) {
          expect(
            tree.rootNode
              .descendantsOfType('call')
              .find((node) => node.childForFieldName('method')?.text === 'foo')
              ?.childForFieldName('block')?.text,
            source
          ).toBe('do end');
          expect(superCall?.childForFieldName('block'), source).toBeNull();
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test('accepts ordinary completed-command assignments as first arguments and return values', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const operator of ['=', '+=', '||=']) {
      for (const source of [
        `foo(b c do end.d ${operator} 1)`,
        `foo(b c do end.d[0] ${operator} 1)`,
        `foo(b c do end.d ${operator} 1, q)`,
        `foo(b c do end.d ${operator} 1 rescue q)`,
        `return b c do end.d ${operator} 1`,
      ]) {
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const assignment = tree.rootNode.descendantsOfType(
            operator === '=' ? 'assignment' : 'operator_assignment'
          )[0];
          expect(assignment?.childForFieldName('left')?.text, source).toBe(
            source.includes('.d[0]') ? 'b c do end.d[0]' : 'b c do end.d'
          );
          expect(assignment?.parent?.type, source).toBe('argument_list');
        } finally {
          tree.delete();
        }
      }
      const source = `foo b c do end.d ${operator} 1`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const assignment = tree.rootNode.namedChildren[0];
        expect(assignment?.type, source).toBe(operator === '=' ? 'assignment' : 'operator_assignment');
        const receiver = assignment?.childForFieldName('left')?.childForFieldName('receiver');
        expect(receiver?.childForFieldName('method')?.text, source).toBe('foo');
        expect(receiver?.childForFieldName('block')?.text, source).toBe('do end');
      } finally {
        tree.delete();
      }
    }
    for (const source of [
      'foo(b c do end.d = e f)',
      'return b c do end.d += e f',
      'foo(q, b c do end.d = 1)',
      'foo([b c do end.d = 1])',
    ]) {
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

test('distinguishes adjacent and line-broken not parentheses from horizontal separation', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const [gaps, operandType] of [
      [['', '\n', '\n ', ' \n', '\r\n', ' # note\n ', '\n=begin\ntext\n=end\n', '\\\n\n'], 'parenthesized_statements'],
      [[' ', '\t', '\f', '\v', '\r', '\\\n', '\\\r\n'], 'test_pattern'],
    ] as const) {
      for (const gap of gaps) {
        for (const [prefix, suffix] of [
          ['', ''],
          ['x = ', ''],
          ['x ||= ', ''],
          ['def f; yield ', '; end'],
          ['def f = ', ''],
        ]) {
          const source = `${prefix}not${gap}(a) in P${suffix}`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const negation = tree.rootNode
              .descendantsOfType('unary')
              .find((node) => node.childForFieldName('operator')?.text === 'not');
            expect(negation?.childForFieldName('operand')?.type, source).toBe(operandType);
            expect(tree.rootNode.descendantsOfType('test_pattern'), source).toHaveLength(1);
            if (gap.includes('#')) {
              expect(
                tree.rootNode.descendantsOfType('comment').map((node) => node.text),
                source
              ).toContain('# note');
            }
            if (gap.includes('=begin')) {
              expect(
                tree.rootNode.descendantsOfType('comment').map((node) => node.text),
                source
              ).toContain('=begin\ntext\n=end');
            }
          } finally {
            tree.delete();
          }
        }
      }
    }
    for (const source of ['not(a).foo', 'not (a).foo', 'not\n(a).foo']) {
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const negation = tree.rootNode.descendantsOfType('unary')[0];
        expect(negation?.childForFieldName('operand')?.type, source).toBe(
          source === 'not (a).foo' ? 'call' : 'parenthesized_statements'
        );
      } finally {
        tree.delete();
      }
    }
    let previousGap = '';
    let tree = parser.parse('not(a) in P')!;
    try {
      for (const gap of [' ', '\n', '\\\n', '\n=begin\ntext\n=end\n', ' # note\n ', '', '\t']) {
        const source = `not${gap}(a) in P`;
        const oldLines = previousGap.split('\n');
        const newLines = gap.split('\n');
        tree.edit(
          new Edit({
            startIndex: 3,
            oldEndIndex: 3 + previousGap.length,
            newEndIndex: 3 + gap.length,
            startPosition: { row: 0, column: 3 },
            oldEndPosition: {
              row: oldLines.length - 1,
              column: oldLines.length === 1 ? 3 + previousGap.length : oldLines.at(-1)!.length,
            },
            newEndPosition: {
              row: newLines.length - 1,
              column: newLines.length === 1 ? 3 + gap.length : newLines.at(-1)!.length,
            },
          })
        );
        const incremental = parser.parse(source, tree)!;
        const fresh = parser.parse(source)!;
        try {
          expect(incremental.rootNode.toString(), source).toBe(fresh.rootNode.toString());
          expect(incremental.rootNode.hasError, source).toBe(false);
          const operator = incremental.rootNode.descendantsOfType('unary')[0]?.childForFieldName('operator');
          expect([operator?.startIndex, operator?.endIndex], source).toEqual([0, 3]);
        } finally {
          tree.delete();
          tree = incremental;
          fresh.delete();
          previousGap = gap;
        }
      }
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test('keeps recursive command negation inside modifiers and their patterns in the clause', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const count of [1, 2, 3, 4, 5]) {
      for (const modifier of ['rescue', 'if', 'unless', 'while', 'until']) {
        for (const prefix of ['', 'foo ']) {
          const source = `def m; ${prefix}${'not '.repeat(count)}b c ${modifier} d in Integer; y; end`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const statement = tree.rootNode.descendantsOfType('body_statement')[0]?.namedChildren[0];
            expect(statement?.type, source).toBe(`${modifier}_modifier`);
            const clause = statement?.childForFieldName(modifier === 'rescue' ? 'handler' : 'condition');
            expect(clause?.type, source).toBe('test_pattern');
            expect(clause?.childForFieldName('value')?.text, source).toBe('d');
            const body = statement?.childForFieldName('body');
            expect(body?.type, source).toBe(prefix ? 'call' : 'unary');
            let operand = prefix ? body?.childForFieldName('arguments')?.namedChildren[0] : body;
            for (let i = 0; i < count; i++) {
              expect(operand?.type, source).toBe('unary');
              operand = operand?.childForFieldName('operand');
            }
            expect(operand?.text, source).toBe('b c');
            expect(tree.rootNode.descendantsOfType('body_statement')[0]?.namedChildren.at(-1)?.text, source).toBe('y');
          } finally {
            tree.delete();
          }
        }
      }
      for (const modifier of ['if', 'unless', 'while', 'until']) {
        const source = `def m; ${'not '.repeat(count)}b c do end.d = 1 ${modifier} d in Integer; y; end`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const statement = tree.rootNode.descendantsOfType('body_statement')[0]?.namedChildren[0];
          expect(statement?.type, source).toBe(`${modifier}_modifier`);
          let operand = statement?.childForFieldName('body');
          for (let i = 0; i < count; i++) {
            expect(operand?.type, source).toBe('unary');
            operand = operand?.childForFieldName('operand');
          }
          expect(operand?.type, source).toBe('assignment');
          expect(statement?.childForFieldName('condition')?.childForFieldName('value')?.text, source).toBe('d');
        } finally {
          tree.delete();
        }
      }
      const source = `def m; x = ${'not '.repeat(count)}b c rescue d in Integer; end`;
      const tree = parser.parse(source)!;
      try {
        expect(tree.rootNode.hasError, source).toBe(false);
        const pattern = tree.rootNode.descendantsOfType('body_statement')[0]?.namedChildren[0];
        expect(pattern?.type, source).toBe('test_pattern');
        const assignment = pattern?.childForFieldName('value');
        expect(assignment?.type, source).toBe('assignment');
        const rescue = assignment?.childForFieldName('right');
        expect(rescue?.type, source).toBe('rescue_modifier');
        let operand = rescue?.childForFieldName('body');
        for (let i = 0; i < count; i++) {
          expect(operand?.type, source).toBe('unary');
          operand = operand?.childForFieldName('operand');
        }
        expect(operand?.text, source).toBe('b c');
        expect(rescue?.childForFieldName('handler')?.text, source).toBe('d');
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});
