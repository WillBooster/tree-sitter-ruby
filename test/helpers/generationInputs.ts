import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function currentWasmPath(root: string): string {
  const wasmPath = path.join(root, 'tree-sitter-ruby.wasm');
  const sources = ['grammar.js', 'src/parser.c', 'src/scanner.c', 'src/tree_sitter/parser.h'].map(
    (name) => fs.statSync(path.join(root, name)).mtimeMs
  );
  assert.ok(
    Math.max(generationInputMtime(root), ...sources) <= fs.statSync(wasmPath).mtimeMs,
    'generation inputs or src/ changed after the Wasm build was built; run `bun run build/ci`'
  );
  return wasmPath;
}

function generationInputMtime(root: string): number {
  const corpus = path.join(root, 'test/corpus');
  const examples = execFileSync('git', ['ls-files', '-z', '--', 'examples'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const recordedPath = path.join(root, '.tmp/generation-profiles/examples.z');
  if (!fs.existsSync(recordedPath)) {
    throw new Error('Generation inputs have not been recorded; run `bun run build/ci`');
  }
  const recordedExamples = fs.readFileSync(recordedPath, 'utf8');
  if (examples.join('\0') + (examples.length > 0 ? '\0' : '') !== recordedExamples) {
    throw new Error('Git-tracked generation examples changed; run `bun run build/ci`');
  }
  const inputs = [
    path.join(root, 'tree-sitter.json'),
    corpus,
    ...fs.readdirSync(corpus, { recursive: true, encoding: 'utf8' }).map((file) => path.join(corpus, file)),
    ...examples.map((file) => path.join(root, file)),
  ];
  return Math.max(
    ...inputs.map((file) => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch (error) {
        throw Object.assign(
          new Error(
            `Cannot read generation input ${path.relative(root, file)}; restore it or stage removed examples, then run \`bun run build/ci\``
          ),
          { cause: error }
        );
      }
    })
  );
}
