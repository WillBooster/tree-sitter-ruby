import path from 'node:path';
import { Language, Parser } from '@willbooster/web-tree-sitter';
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
