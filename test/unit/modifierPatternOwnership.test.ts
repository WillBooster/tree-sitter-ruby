import path from 'node:path';
import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

test('keeps match patterns inside modifier conditions across following statements', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const modifier of ['if', 'unless', 'while', 'until']) {
      for (const operator of ['and', 'or']) {
        for (const body of ['z', 'b c']) {
          for (const suffix of ['; y', '\ny\n', ' and f\ny\n']) {
            const source = `${body} ${modifier} c ${operator} e => v${suffix}`;
            const tree = parser.parse(source)!;
            try {
              expect(tree.rootNode.hasError, source).toBe(false);
              const statement = tree.rootNode.namedChildren[0];
              expect(statement?.type, source).toBe(`${modifier}_modifier`);
              const condition = statement?.childForFieldName('condition');
              expect(condition?.descendantsOfType('match_pattern')[0]?.childForFieldName('value')?.text, source).toBe(
                'e'
              );
              expect(tree.rootNode.namedChildren.at(-1)?.text, source).toBe('y');
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
