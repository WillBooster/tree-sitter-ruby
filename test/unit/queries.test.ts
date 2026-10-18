import path from 'node:path';
import { Language, Parser, Query } from '@willbooster/web-tree-sitter';
import { expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

test('queries variable receivers in ordinary and endless singleton methods', async () => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, '(singleton_method object: (_variable) @receiver)');
  const tree = parser.parse('def obj.method; end\ndef other.method = value\ndef Obj.method; end\n')!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(query.captures(tree.rootNode).map(({ node }) => node.text)).toEqual(['obj', 'other', 'Obj']);
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }
});
