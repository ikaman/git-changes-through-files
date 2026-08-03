'use strict';

// Integration-style tests for navigate() (src/extension.ts), driven through the
// commands it registers, against out/extension.js. Run `npm run compile` first
// (the `pretest` script does this automatically via `npm test`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, openNormal, openFocusOriginal, openStaleTabGroup } = require('./vscode-mock');

function mixedFiles() {
  return [
    { id: 'a.txt', hunkLines: [5, 15, 30] },
    { id: 'b.txt', hunkLines: [2] },
    { id: 'c.txt', hunkLines: [] }, // untracked/binary -- no parseable diff
    { id: 'd.txt', hunkLines: [10, 20] },
  ];
}

// Deterministic pseudo-random file lists, so failures are reproducible by seed.
function randomFiles(n, seed) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const files = [];
  for (let i = 0; i < n; i++) {
    const hunkCount = Math.floor(rand() * 4); // 0..3
    const hunks = [];
    let line = 2 + Math.floor(rand() * 5);
    for (let h = 0; h < hunkCount; h++) {
      hunks.push(line);
      line += 3 + Math.floor(rand() * 8);
    }
    files.push({ id: `f${i}.txt`, hunkLines: hunks });
  }
  return files;
}

// Presses "next" once per real hunk, asserting every press lands on a new,
// not-yet-visited hunk position (i.e. navigation never stalls and never skips).
async function assertWalksAllHunksForward(files, openBehavior) {
  const ctx = setup(files, openBehavior);
  const expected = [];
  for (const f of files) {
    for (const L of f.hunkLines) expected.push(`/repo/${f.id}:${L - 1}`);
  }
  // Each file costs one press to open (landing on its first hunk, or on line 0
  // if it has no parseable diff) plus one further press per additional hunk.
  const pressBudget = files.reduce((s, f) => s + Math.max(f.hunkLines.length, 1), 0);

  const seen = new Set();
  let prevKey = null;
  for (let i = 0; i < pressBudget; i++) {
    await ctx.next();
    const key = ctx.currentKey();
    assert.notStrictEqual(
      key, prevKey,
      `press ${i + 1}/${pressBudget} repeated "${key}" instead of advancing (stuck)`
    );
    seen.add(key);
    prevKey = key;
  }

  for (const key of expected) {
    assert.ok(seen.has(key), `hunk ${key} was never visited`);
  }
}

test('normal focus: walks every hunk across multiple files in order, no stalls', async () => {
  await assertWalksAllHunksForward(mixedFiles(), openNormal);
});

test('focus lands on the original/HEAD pane: still walks every hunk, no stalls', async () => {
  await assertWalksAllHunksForward(mixedFiles(), openFocusOriginal);
});

test('regression: diff open in a background editor group is still recognized (does not re-jump to hunk 1 forever)', async () => {
  // Before the isViewingChange() fix, this reproduced 100% of the time: with the
  // diff open in a non-focused split-editor group, every press re-opened the
  // same file and jumped back to its FIRST hunk instead of advancing.
  await assertWalksAllHunksForward(mixedFiles(), openStaleTabGroup);
});

test('files with no parseable diff (untracked/binary) are skipped without stalling navigation', async () => {
  // Names matter: navigate() sorts files the same way VS Code's Source Control
  // list view does, so "a-*" is guaranteed to be visited before "b-*".
  const files = [
    { id: 'a-untracked.txt', hunkLines: [] },
    { id: 'b-tracked.txt', hunkLines: [3] },
  ];
  const ctx = setup(files, openNormal);
  await ctx.next(); // opens a-untracked.txt (no hunk to land on)
  await ctx.next(); // must fall through to b-tracked.txt's first hunk
  assert.strictEqual(ctx.currentKey(), '/repo/b-tracked.txt:2');
});

test('stops at the last change without wrapAround and shows an info message', async () => {
  const files = [{ id: 'only.txt', hunkLines: [4] }];
  const ctx = setup(files, openNormal);
  await ctx.next(); // lands on the only hunk
  const before = ctx.currentKey();
  await ctx.next(); // no more changes
  assert.strictEqual(ctx.currentKey(), before, 'position must not change past the last hunk');
  assert.ok(
    ctx.state.messages.some((m) => m.includes('Already at the last change')),
    'expected an "already at the last change" message'
  );
});

test('stress: many random file/hunk layouts never stall or skip, across focus quirks', async () => {
  const behaviors = { normal: openNormal, focusOriginal: openFocusOriginal, staleTabGroup: openStaleTabGroup };
  for (let seed = 1; seed <= 25; seed++) {
    const files = randomFiles(5, seed);
    if (files.every((f) => f.hunkLines.length === 0)) continue; // nothing to walk
    for (const [name, behavior] of Object.entries(behaviors)) {
      await assertWalksAllHunksForward(files, behavior).catch((err) => {
        throw new Error(`seed=${seed} behavior=${name}: ${err.message}`);
      });
    }
  }
});
