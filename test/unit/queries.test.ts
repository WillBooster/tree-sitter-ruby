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

test('queries expression supertypes inside yield and ordinary arguments', async () => {
  await Parser.init();
  const language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, '(_arg) @argument\n(_primary) @primary');
  const source = 'def f; yield 1; end\nfoo(2)\n';
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(
      query
        .captures(tree.rootNode)
        .filter(({ node }) => node.type === 'integer')
        .map(({ name, node }) => [name, node.text, node.startIndex, node.endIndex])
    ).toEqual([
      ['argument', '1', 13, 14],
      ['primary', '1', 13, 14],
      ['argument', '2', 24, 25],
      ['primary', '2', 24, 25],
    ]);
  } finally {
    tree.delete();
    query.delete();
    parser.delete();
  }
});
