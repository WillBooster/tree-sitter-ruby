import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

test('return, break, and next own literal operands without reading a binary operator', async () => {
  await Parser.init();
  const parser = new Parser().setLanguage(
    await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')))
  );
  try {
    for (const keyword of ['return', 'break', 'next']) {
      for (const gap of ['', ' ', '\t', '\\\n']) {
        for (const [literal, type] of [
          ['% q ', 'string'],
          ['%q q ', 'string'],
          ['%Q #{1} ', 'string'],
          ['%x q ', 'subshell'],
          ['%s q ', 'delimited_symbol'],
          ['%r q ', 'regex'],
          ['/ q/', 'regex'],
          ['/=/', 'regex'],
          ['<<EOS\nq\nEOS\n', 'heredoc_beginning'],
        ]) {
          const source = `def f; loop { ${keyword}${gap}${literal}\n}; end`;
          const tree = parser.parse(source)!;
          try {
            expect(tree.rootNode.hasError, source).toBe(false);
            const jump = tree.rootNode.descendantsOfType(keyword)[0];
            expect(jump?.namedChildren[0]?.type, source).toBe('argument_list');
            expect(jump?.namedChildren[0]?.namedChildren[0]?.type, source).toBe(type);
            expect(jump?.namedChildren[0]?.namedChildren[0]?.text, source).toBe(
              type === 'heredoc_beginning' ? '<<EOS' : literal
            );
            expect(tree.rootNode.descendantsOfType('binary'), source).toHaveLength(0);
          } finally {
            tree.delete();
          }
        }
      }
      for (const literal of ['%w q ', '%W q ', '%i q ', '%I q ', '%r\r\nq\r\n']) {
        const source = `def f; loop { ${keyword} ${literal}\n}; end`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.descendantsOfType('regex'), source).toHaveLength(0);
          if (!literal.startsWith('%r')) expect(tree.rootNode.hasError, source).toBe(true);
        } finally {
          tree.delete();
        }
      }
      for (const separator of ['\n', ';', ' # note\n']) {
        const source = `def f; loop { ${keyword}${separator}% q \n}; end`;
        const tree = parser.parse(source)!;
        try {
          expect(tree.rootNode.hasError, source).toBe(false);
          const jump = tree.rootNode.descendantsOfType(keyword)[0];
          expect(jump?.namedChildCount, source).toBe(0);
          expect(tree.rootNode.descendantsOfType('string')[0]?.parent?.type, source).toBe('block_body');
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});
