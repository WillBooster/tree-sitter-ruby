import path from 'node:path';

import { Language, Parser } from '@willbooster/web-tree-sitter';
import { beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';

let language: Language;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(path.join(import.meta.dirname, '../..')));
});

test.each([
  'def obj.method; end\ndef other.method = value\ndef Obj.method; end\n',
  'def f; yield 1; end\nfoo(2)\n',
  'foo(1)\nfoo bar 2\ndef f; yield 3; end\nx in Integer\nvalue => Integer\n',
  'x = foo bar',
  'x += foo bar',
  'a b do end.c = foo bar',
  'a b do end.c += foo bar',
  'x = foo bar rescue q',
  'not foo bar',
  '!foo bar',
  'not foo bar in Integer',
  'def f; yield not foo bar; end',
  'def f; yield not foo bar in Integer; end',
  'not a b do end.c = 1',
  'def f; yield not x += foo y; end',
  ...['private', 'protected', 'public'].map(
    (name) =>
      `${name}\nreceiver.${name}\ndef ${name}(${name})\n  ${name} = 1\n  ${name}\nend\n:${name}\nif true\n  return\nend`
  ),
])('parses %j without errors', (source) => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
  } finally {
    tree.delete();
    parser.delete();
  }
});
