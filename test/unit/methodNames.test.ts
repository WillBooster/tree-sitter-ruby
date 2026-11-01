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

test.each(['self', 'super', 'Name', 'true', 'false', 'nil', 'if', 'class', 'end'])(
  'owns the complete body of a method named %s',
  (name) => {
    const source = `def ${name}(value)\n  inside = value\nend\nfollowing`;
    checkSource(source, false, (node) => {
      expect(node.namedChildren.map(({ type }) => type)).toEqual(['method', 'identifier']);
      const method = node.firstNamedChild!;
      expect(method.childForFieldName('name')!.text).toBe(name);
      expect(method.childForFieldName('parameters')!.namedChildren.map(({ text }) => text)).toEqual(['value']);
      expect(
        method
          .childForFieldName('body')!
          .descendantsOfType('assignment')
          .map(({ text }) => text)
      ).toEqual(['inside = value']);
      expect(method.endIndex).toBe(source.indexOf('\nfollowing'));
    });
  }
);

test.each(['self', 'super', 'Name', 'ordinary'])('owns the complete body of a setter named %s=', (name) => {
  const source = `def ${name}=(value)\n  @stored = value\nend\nfollowing`;
  checkSource(source, false, (node) => {
    expect(node.namedChildren.map(({ type }) => type)).toEqual(['method', 'identifier']);
    const method = node.firstNamedChild!;
    const setter = method.childForFieldName('name')!;
    expect(setter.type).toBe('setter');
    expect(setter.text).toBe(`${name}=`);
    expect(setter.childForFieldName('name')!.text).toBe(name);
    expect(
      method
        .childForFieldName('body')!
        .descendantsOfType('assignment')
        .map(({ text }) => text)
    ).toEqual(['@stored = value']);
    expect(method.endIndex).toBe(source.indexOf('\nfollowing'));
  });
});

test.each(['self', 'super', 'Name'])('parses endless methods named %s in both body forms', (name) => {
  for (const [header, body] of [
    [`${name}(value)`, 'value'],
    [name, 'sink value'],
  ]) {
    const source = `def ${header} = ${body}\nfollowing`;
    checkSource(source, false, (node) => {
      expect(node.namedChildren.map(({ type }) => type)).toEqual(['method', 'identifier']);
      expect(node.firstNamedChild!.childForFieldName('name')!.text).toBe(name);
      expect(node.firstNamedChild!.childForFieldName('body')!.text).toBe(body);
    });
  }
});

test.each(['<=>', '===', '=~', '>=', '<=', '+', '!=', '-', '!@', '!~', '~', '+@', '-@', '~@', '`'])(
  'accepts a gapless endless delimiter after operator %s',
  (operator) => {
    for (const body of ['1', 'sink value', 'yield value']) {
      for (const receiver of ['', 'self.']) {
        checkSource(`def ${receiver}${operator}=${body}\nfollowing`, false, (node) => {
          const method = node.firstNamedChild!;
          expect(method.type).toBe(receiver ? 'singleton_method' : 'method');
          expect(method.childForFieldName('name')!.text).toBe(operator);
          expect(method.childForFieldName('body')!.text).toBe(body);
        });
      }
    }
  }
);

test.each(['|', '^', '&', '==', '>', '<', '*', '/', '%', '!', '**', '<<', '>>', '[]'])(
  'requires separation before an endless delimiter after operator %s',
  (operator) => {
    checkSource(`def ${operator}=1\nfollowing`, true);
    checkSource(`def ${operator} =1\nfollowing`, false, (node) => {
      expect(node.firstNamedChild!.childForFieldName('name')!.text).toBe(operator);
      expect(node.firstNamedChild!.childForFieldName('body')!.text).toBe('1');
    });
  }
);

test('owns the complete body of an array setter definition', () => {
  const source = 'def []=(index, value)\n  @stored = value\nend\nfollowing';
  checkSource(source, false, (node) => {
    expect(node.namedChildren.map(({ type }) => type)).toEqual(['method', 'identifier']);
    const method = node.firstNamedChild!;
    expect(method.childForFieldName('name')!.type).toBe('operator');
    expect(method.childForFieldName('name')!.text).toBe('[]=');
    expect(method.childForFieldName('parameters')!.namedChildren.map(({ text }) => text)).toEqual(['index', 'value']);
    expect(
      method
        .childForFieldName('body')!
        .descendantsOfType('assignment')
        .map(({ text }) => text)
    ).toEqual(['@stored = value']);
    expect(method.endIndex).toBe(source.indexOf('\nfollowing'));
  });
});

test.each(['!@', '~@', '+@', '-@'])('parses a unary operator definition named %s', (operator) => {
  checkSource(`def ${operator}; true; end\nfollowing`, false, (node) => {
    expect(node.namedChildren.map(({ type }) => type)).toEqual(['method', 'identifier']);
    expect(node.firstNamedChild!.childForFieldName('name')!.type).toBe('operator');
    expect(node.firstNamedChild!.childForFieldName('name')!.text).toBe(operator);
  });
});

test.each(['self', '@receiver', '$receiver', 'receiver'])(
  'retains the receiver of a singleton definition on %s',
  (receiver) => {
    checkSource(`def ${receiver}.self(value); value; end\nfollowing`, false, (node) => {
      expect(node.namedChildren.map(({ type }) => type)).toEqual(['singleton_method', 'identifier']);
      expect(node.firstNamedChild!.childForFieldName('object')!.text).toBe(receiver);
      expect(node.firstNamedChild!.childForFieldName('name')!.text).toBe('self');
    });
  }
);

test.each([
  ['alias self super', 'self', 'super'],
  ['alias :self :super', ':self', ':super'],
  ['alias $new $old', '$new', '$old'],
  ['alias $1 $old', '$1', '$old'],
  ['alias $new $0', '$new', '$0'],
  ['alias $new $&', '$new', '$&'],
])('retains the names in %s', (statement, name, original) => {
  checkSource(`${statement}\nfollowing`, false, (node) => {
    const alias = node.firstNamedChild!;
    expect(alias.type).toBe('alias');
    expect(alias.childForFieldName('name')!.text).toBe(name);
    expect(alias.childForFieldName('alias')!.text).toBe(original);
  });
});

test('retains keyword and quoted names in undef', () => {
  checkSource('undef self, :super, :"arbitrary name"\nfollowing', false, (node) => {
    expect(node.firstNamedChild!.type).toBe('undef');
    expect(node.firstNamedChild!.namedChildren.map(({ text }) => text)).toEqual([
      'self',
      ':super',
      ':"arbitrary name"',
    ]);
  });
});

test.each([
  'def :foo; end',
  'def :"foo"; end',
  'def @x; end',
  'def @@x; end',
  'def $x; end',
  'def ..; end',
  'alias @x @y',
  'alias @@x @@y',
  'alias $x foo',
  'alias foo $x',
  'alias $x $1',
  'alias $1 $2',
  'undef @x',
  'undef @@x',
  'undef $x',
  'def ordinary=(value) = value',
  'def self=(value) = value',
  'def []=(index, value) = value',
  'def ordinary=1',
  'def ordinary?=true',
  'def ordinary!=true',
  'def ordinary\n = 1',
  'def ordinary(value)\n = value',
])('reports invalid names or definition boundaries in %s', (source) => {
  checkSource(source, true);
});

test.each(['', ' ', '\t', '\\\n', '\\\r\n'])('accepts the header/body gap %j after explicit parameters', (gap) => {
  checkSource(`def ordinary(value)${gap}=value\nfollowing`, false, (node) => {
    expect(node.firstNamedChild!.type).toBe('method');
    expect(node.firstNamedChild!.childForFieldName('body')!.text).toBe('value');
  });
});

test.each([' ', '\t', '\f', '\v', '\r', '\\\n', '\\\r\n'])(
  'accepts the separating gap %j in a parameterless endless definition',
  (gap) => {
    checkSource(`def ordinary${gap}=1\nfollowing`, false, (node) => {
      expect(node.firstNamedChild!.type).toBe('method');
      expect(node.firstNamedChild!.childForFieldName('name')!.text).toBe('ordinary');
      expect(node.firstNamedChild!.childForFieldName('body')!.text).toBe('1');
    });
  }
);

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
