import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('function unquoteGitPath(');
const end = source.indexOf('const basename', start);
const parse = vm.runInNewContext(source.slice(start, end) + '; fileSections', { TextDecoder, Uint8Array });
const tree = vm.runInNewContext(source.slice(source.indexOf('function buildTree('), source.indexOf('// Per-status codicon')) + '; buildTree', {});
test('unquoted filename with spaces', () => {
  assert.equal(parse('diff --git a/space name.txt b/space name.txt\n+second')[0]?.path, 'space name.txt');
});
test('quoted filename with a tab', () => {
  assert.equal(parse('diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"\n+second')[0]?.path, 'tab\tname.txt');
});
test('C-quoted UTF-8 filename', () => {
  assert.equal(parse('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"')[0]?.path, 'café.txt');
});

test('repeated file sections remain distinct', () => {
  assert.equal(parse('diff --git a/a.txt b/a.txt\n+one\ndiff --git a/a.txt b/a.txt\n+two').length, 2);
});

test('split layout renders sides: removes left, adds right, context both', () => {
  const rows = [
    { kind: 'context', before: 1, after: 1, text: ' ctx' },
    { kind: 'remove', before: 2, text: '-old' },
    { kind: 'add', after: 2, text: '+new' },
  ];
  const split = parse; // parse is fileSections; exercise splitRows from the source
  const src = source;
  const start = src.indexOf('function splitRows(');
  const end = src.indexOf('function renderSplitRow(');
  const splitRows = vm.runInNewContext(src.slice(start, end) + '; splitRows', {});
  const result = splitRows(rows);
  assert.equal(result.left.length, 2); // context + remove
  assert.equal(result.right.length, 2); // context + add
  assert.equal(result.left[1].kind, 'remove');
  assert.equal(result.right[1].kind, 'add');
});

test('splitRows renders hunk/fold once as shared rows and pads unequal groups', () => {
  const start = source.indexOf('function splitRows(');
  const end = source.indexOf('function renderSplitRow(');
  const splitRows = vm.runInNewContext(source.slice(start, end) + '; splitRows', {});
  const rows = [{ kind: 'hunk', text: '@@' }, { kind: 'fold', count: 10 }, { kind: 'remove', text: '-old' }, { kind: 'add', text: '+x' }, { kind: 'add', text: '+y' }, { kind: 'context', text: 'next' }];
  const result = splitRows(rows);
  assert.equal(result.pairs.length, 5);
  assert.equal(result.pairs[0].shared.kind, 'hunk');
  assert.equal(result.pairs[1].shared.kind, 'fold');
  assert.equal(result.left.length, 3);
  assert.equal(result.right.length, 3);
  assert.equal(result.left[1].kind, 'empty');
  assert.equal(result.right[1].text, '+y');
  assert.equal(result.left[2].text, 'next');
  assert.equal(result.right[2].text, 'next');
});

test('compacted folders merge single-child chains with "/"', () => {
  const start = source.indexOf('function compactTree(');
  const end = source.indexOf('function countFiles(');
  const compactTree = vm.runInNewContext(source.slice(start, end) + '; compactTree', {});
  const nested = tree(['a/b/c/one.txt', 'a/b/c/two.txt', 'top.txt']);
  const compacted = compactTree(nested);
  // a -> b -> c chain with no intermediate files collapses to one "a/b/c" key
  assert.ok(':a/b/c' in compacted, `expected compacted key, got ${Object.keys(compacted)}`);
  assert.equal(compacted[':a/b/c'].__files.length, 2);
  assert.ok(compacted.__files.includes('top.txt'));
});

test('prototype-looking and sentinel filenames stay ordinary folders', () => {
  const original = Object.prototype.__files;
  const result = tree(['__proto__/secret.txt', '__files/other.txt', 'constructor/third.txt']);
  assert.equal(Object.prototype.__files, original);
  assert.equal(result[':__proto__'].__files[0], '__proto__/secret.txt');
  assert.equal(result[':__files'].__files[0], '__files/other.txt');
  assert.equal(result[':constructor'].__files[0], 'constructor/third.txt');
});

