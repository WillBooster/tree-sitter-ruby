import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Node } from '@willbooster/web-tree-sitter';
import { expect } from 'vitest';

export class NativeParser {
  private readonly directory: string;
  private readonly library: string;

  constructor(private readonly root: string) {
    this.directory = fs.mkdtempSync(path.join(root, '.tmp/native-parser-'));
    this.library = path.join(this.directory, 'ruby.dylib');
    try {
      execFileSync('script/tree-sitter', ['build', '--output', this.library, root], { cwd: root, timeout: 300_000 });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  check(source: string, node: Node): void {
    const file = path.join(this.directory, `${createHash('sha256').update(source).digest('hex')}.rb`);
    fs.writeFileSync(file, source);
    const result = spawnSync(
      'script/tree-sitter',
      ['parse', '--lib-path', this.library, '--lang-name', 'ruby', '--no-ranges', file],
      { cwd: this.root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(node.hasError ? 1 : 0);
    if (node.hasError) expect(result.stdout).toMatch(/ERROR|MISSING/);
    else expect(result.stdout.trim().replaceAll(/\s+/g, ' ')).toBe(node.toString());
  }

  dispose(): void {
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
