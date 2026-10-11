/// <reference types="vite/client" />
import { Language, Parser } from '@willbooster/web-tree-sitter';
import runtimeUrl from '@willbooster/web-tree-sitter/web-tree-sitter.wasm?url';
import { expect, test } from 'vitest';

import rubyUrl from '../../../tree-sitter-ruby.wasm?url';

test('parses in a browser, loading the Wasm files over HTTP', async () => {
  await Parser.init({ locateFile: () => runtimeUrl });
  const parser = new Parser();
  parser.setLanguage(await Language.load(rubyUrl));
  expect(parser.parse('puts "Hello"')?.rootNode.toString()).toBe(
    '(program (call method: (identifier) arguments: (argument_list (string (string_content)))))'
  );
});
