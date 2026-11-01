import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { currentWasmPath } from '../helpers/generationInputs.js';
import { NativeParser } from '../helpers/nativeParser.js';

const root = path.join(import.meta.dirname, '../..');
let language: Language;
let nativeParser: NativeParser;

beforeAll(async () => {
  await Parser.init();
  language = await Language.load(currentWasmPath(root));
  nativeParser = new NativeParser(root);
}, 300_000);

afterAll(() => nativeParser?.dispose());

test.each(['!@', '+@', '~@', '<=>', '===', '[]=', '`'])(
  'retains the complete operator symbol %s before another array element',
  (name) => {
    checkSymbol(name);
  }
);

test.each(['$1', '$0', '$-x', '$-é', '$-_', '$-1', '$!', "$'", '$"', '$&', '$~', '$name'])(
  'retains the complete global-variable symbol %s',
  (name) => {
    checkSymbol(name);
  }
);

test.each(['ordinary', 'ordinary?', 'ordinary!', 'ordinary=', 'Foo=', '言', '@name', '@@name'])(
  'retains the complete identifier symbol %s',
  (name) => {
    checkSymbol(name);
  }
);

test.each(['alias :!@ :!', 'undef :!@'])('retains unary operator symbols in %s', (statement) => {
  checkSource(`${statement}\nfollowing`, false, (node) => {
    expect(node.firstNamedChild!.descendantsOfType('simple_symbol').map(({ text }) => text)).toEqual(
      statement.startsWith('alias') ? [':!@', ':!'] : [':!@']
    );
  });
});

test.each([
  '..',
  '...',
  '1',
  '123',
  '1abc',
  '@1',
  '@@1',
  '+word',
  '!word',
  '+@word',
  '[]=word',
  '~@word',
  '$00',
  '$01',
  '$-xx',
  '$+@',
  '$%',
  '$^',
  '@name?',
  '@name!',
  '@name=',
  '@@name?',
  '$name?',
  '$name!',
  '$name=',
  'ordinary!~/body/',
  'ordinary?==1',
])('reports invalid unquoted symbol text %s', (name) => {
  checkSource(`value = :${name}\nfollowing`, true);
});

test.each(['!=', '!~', '==', '===', '=~'])('keeps comparison %s outside an identifier symbol', (operator) => {
  const operand = operator.endsWith('~') ? '/body/' : '1';
  const gap = operator === '!~' ? ' ' : '';
  checkSource(`value = :ordinary${gap}${operator}${operand}\nfollowing`, false, (node) => {
    const binary = node.firstNamedChild!.childForFieldName('right')!;
    expect(binary.type).toBe('binary');
    expect(binary.childForFieldName('left')!.type).toBe('simple_symbol');
    expect(binary.childForFieldName('left')!.text).toBe(':ordinary');
    expect(binary.childForFieldName('operator')!.text).toBe(operator);
    expect(binary.childForFieldName('right')!.text).toBe(operand);
  });
});

test.each(['ordinary', 'ordinary='])('keeps an adjacent rightward match outside symbol %s', (name) => {
  checkSource(`value = :${name}=>target\nfollowing`, false, (node) => {
    const match = node.firstNamedChild!;
    expect(match.type).toBe('match_pattern');
    expect(match.childForFieldName('value')!.childForFieldName('right')!.text).toBe(`:${name}`);
    expect(match.childForFieldName('pattern')!.text).toBe('target');
  });
});

test.each([
  ['{:a=>1}', ':a'],
  ['{:a==>1}', ':a='],
  ['{:a= =>1}', ':a='],
  ['{:a! =>1}', ':a!'],
  ['{:a? =>1}', ':a?'],
])('preserves the complete key in %s', (literal, symbol) => {
  checkSource(`${literal}\nfollowing`, false, (node) => {
    const pair = node.firstNamedChild!.firstNamedChild!;
    expect(pair.type).toBe('pair');
    expect(pair.childForFieldName('key')!.type).toBe('simple_symbol');
    expect(pair.childForFieldName('key')!.text).toBe(symbol);
    expect(pair.childForFieldName('value')!.text).toBe('1');
  });
});

test.each(['{:a!=>1}', '{:a?=>1}', '{:a!==>1}', '{:a===>1}'])(
  'reports invalid compact symbol/hash delimiters in %s',
  (literal) => {
    checkSource(`${literal}\nfollowing`, true);
  }
);

test.each(['|', '^', '&', '*', '/', '%', '**', '<<', '>>'])(
  'does not split compound assignment after symbol operator %s',
  (operator) => {
    checkSource(`value = :${operator}==1\nfollowing`, true);
    checkSource(`value = :${operator}=>target\nfollowing`, true);
    checkSource(`value = :${operator} ==1\nfollowing`, false, (node) => {
      const binary = node.firstNamedChild!.childForFieldName('right')!;
      expect(binary.type).toBe('binary');
      expect(binary.childForFieldName('left')!.text).toBe(`:${operator}`);
      expect(binary.childForFieldName('operator')!.text).toBe('==');
      expect(binary.childForFieldName('right')!.text).toBe('1');
    });
  }
);

test.each(['+', '-', '~', '+@', '!@', '[]=', '<=>'])(
  'retains an adjacent equality comparison after operator symbol %s',
  (operator) => {
    checkSource(`value = :${operator}==1\nfollowing`, false, (node) => {
      const binary = node.firstNamedChild!.childForFieldName('right')!;
      expect(binary.type).toBe('binary');
      expect(binary.childForFieldName('left')!.text).toBe(`:${operator}`);
      expect(binary.childForFieldName('operator')!.text).toBe('==');
      expect(binary.childForFieldName('right')!.text).toBe('1');
    });
  }
);

test.each(['&&', '||'])('does not split boolean operator text %s into a symbol and binary operator', (operator) => {
  checkSource(`value = :${operator}1\nfollowing`, true);
});

function checkSymbol(name: string): void {
  checkSource(`value = [:${name}, 'after']\nfollowing`, false, (node) => {
    const array = node.firstNamedChild!.childForFieldName('right')!;
    expect(array.type).toBe('array');
    expect(array.namedChildren.map(({ type }) => type)).toEqual(['simple_symbol', 'string']);
    expect(array.firstNamedChild!.text).toBe(`:${name}`);
    expect(array.lastNamedChild!.text).toBe("'after'");
  });
}

function checkSource(source: string, hasError: boolean, inspect?: (node: Node) => void): void {
  const parser = new Parser().setLanguage(language);
  const tree = parser.parse(source)!;
  try {
    const node = tree.rootNode;
    expect(node.hasError, source).toBe(hasError);
    if (!hasError) expect(node.lastNamedChild!.text).toBe('following');
    inspect?.(node);
    nativeParser.check(source, node);
  } finally {
    tree.delete();
    parser.delete();
  }
}
