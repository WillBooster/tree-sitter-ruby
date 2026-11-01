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
  '__END__ = 4',
  '__END__=4',
  '__END__ # comment',
  '__END__ ',
  '__END__\t',
  '__END__suffix',
  ' __END__',
  '\t__END__',
  'first;__END__',
])('keeps %j and the following statement as Ruby source', (line) => {
  const parser = new Parser().setLanguage(language);
  const source = `${line}\nfollowing`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('uninterpreted')).toHaveLength(0);
    expect(tree.rootNode.lastNamedChild!.text).toBe('following');
    expect(tree.rootNode.descendantsOfType('identifier').map(({ text }) => text)).toContain(
      line.includes('suffix') ? '__END__suffix' : '__END__'
    );
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['__END__\r', '__END__\rfollowing'])('keeps a bare carriage return in Ruby source %j', (source) => {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('uninterpreted')).toHaveLength(0);
    expect(tree.rootNode.descendantsOfType('identifier').map(({ text }) => text)).toContain('__END__');
  } finally {
    tree.delete();
    parser.delete();
  }
});

test.each(['', '\n', '\r\n'])('recognizes an exact end marker followed by %j', (newline) => {
  const parser = new Parser().setLanguage(language);
  const data = newline ? `${newline}# data\n<<DOC\nnot ruby }` : '';
  const source = `first\n__END__${data}`;
  const tree = parser.parse(source)!;
  try {
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.firstNamedChild!.text).toBe('first');
    const raw = tree.rootNode.lastNamedChild!;
    expect(raw.type).toBe('uninterpreted');
    expect(raw.text).toBe(data);
    expect(raw.endIndex).toBe(source.length);
  } finally {
    tree.delete();
    parser.delete();
  }
});
