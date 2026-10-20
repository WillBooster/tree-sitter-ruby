import path from 'node:path';
import { Language, Parser } from '@willbooster/web-tree-sitter';
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
