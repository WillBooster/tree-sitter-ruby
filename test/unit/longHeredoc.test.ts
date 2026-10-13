import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('retains long heredoc identifiers and many short heredocs', () => {
  fs.mkdirSync(path.join(repositoryRoot, '.tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(repositoryRoot, '.tmp/long-heredoc-'));
  const parserPath = path.join(directory, 'ruby.so');
  try {
    execFileSync('script/tree-sitter', ['build', '-o', parserPath, '.'], { cwd: repositoryRoot });
    const cases = [
      ['A'.repeat(255)],
      ['A'.repeat(1018)],
      ['A'.repeat(256), 'B'],
      ['A'.repeat(255), 'B'.repeat(250), 'C'.repeat(250), 'D'.repeat(250)],
      Array.from({ length: 200 }, () => 'A'),
    ];
    for (const [index, words] of cases.entries()) {
      const source =
        `x = [${words.map((word) => `<<${word}`).join(', ')}]\n` +
        words.map((word) => `puts 1\n${word}\n`).join('') +
        'f = 2\n';
      const sourcePath = path.join(directory, `heredoc-${index}.rb`);
      fs.writeFileSync(sourcePath, source);
      const result = spawnSync(
        'script/tree-sitter',
        ['parse', '--lib-path', parserPath, '--lang-name', 'ruby', sourcePath],
        { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 }
      );
      const output = result.stdout + result.stderr;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(0);
      expect(result.stdout.match(/\(heredoc_body\b/g), output).toHaveLength(words.length);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
