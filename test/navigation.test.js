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

// ── Same path listed under BOTH Staged Changes and Changes ────────────────────
// Mirrors this real repo:
//   git mv a.txt a2.txt; git mv b.txt b2.txt   (staged pure renames)
//   edit a2.txt, b2.txt and c.txt              (unstaged edits)
// Source Control panel: Staged [a2, b2], Changes [a2, b2, c].

function bothGroupsRepo() {
  return {
    files: [
      { id: 'a2.txt', hunkLines: [5] },
      { id: 'b2.txt', hunkLines: [5] },
      { id: 'c.txt', hunkLines: [7] },
    ],
    staged: [
      { id: 'a2.txt', renamedFrom: 'a.txt', hunkLines: [] }, // pure rename: no content change
      { id: 'b2.txt', renamedFrom: 'b.txt', hunkLines: [] },
    ],
  };
}

// Every entry of the panel exactly once, top to bottom. A pure rename has no
// hunk to land on, so its diff is shown with the cursor left at line 0.
const BOTH_GROUPS_FORWARD = [
  'staged:a2.txt:0',
  'staged:b2.txt:0',
  'changes:a2.txt:4',
  'changes:b2.txt:4',
  'changes:c.txt:6',
];

const behaviors = { normal: openNormal, focusOriginal: openFocusOriginal, staleTabGroup: openStaleTabGroup };

test('same path in Staged and Changes: Next visits each entry once, in panel order, then stops', async (t) => {
  for (const [name, behavior] of Object.entries(behaviors)) {
    for (const closeFileOnMove of [false, true]) {
      await t.test(`behavior=${name} closeFileOnMove=${closeFileOnMove}`, async () => {
        const { files, staged } = bothGroupsRepo();
        const ctx = setup(files, behavior, staged);
        ctx.state.config['gitChangesThrough.closeFileOnMove'] = closeFileOnMove;
        const seen = [];
        for (let i = 0; i < BOTH_GROUPS_FORWARD.length; i++) {
          await ctx.next();
          seen.push(ctx.currentView());
        }
        assert.deepStrictEqual(seen, BOTH_GROUPS_FORWARD);

        await ctx.next();
        assert.strictEqual(ctx.currentView(), 'changes:c.txt:6', 'must not move past the last entry');
        assert.ok(ctx.state.messages.some((m) => m.includes('Already at the last change')));
      });
    }
  }
});

test('same path in Staged and Changes: Previous is the exact reverse of Next', async (t) => {
  for (const [name, behavior] of Object.entries(behaviors)) {
    await t.test(`behavior=${name}`, async () => {
      const { files, staged } = bothGroupsRepo();
      const ctx = setup(files, behavior, staged);
      for (let i = 0; i < BOTH_GROUPS_FORWARD.length; i++) await ctx.next();

      const seen = [ctx.currentView()];
      for (let i = 1; i < BOTH_GROUPS_FORWARD.length; i++) {
        await ctx.prev();
        seen.push(ctx.currentView());
      }
      assert.deepStrictEqual(seen, [...BOTH_GROUPS_FORWARD].reverse());

      await ctx.prev();
      assert.strictEqual(ctx.currentView(), 'staged:a2.txt:0', 'must not move before the first entry');
      assert.ok(ctx.state.messages.some((m) => m.includes('Already at the first change')));
    });
  }
});

test('same path in Staged and Changes: wrapAround goes from the last entry back to the first (staged) one', async () => {
  const { files, staged } = bothGroupsRepo();
  const ctx = setup(files, openNormal, staged);
  ctx.state.config['gitChangesThrough.wrapAround'] = true;
  for (let i = 0; i < BOTH_GROUPS_FORWARD.length; i++) await ctx.next();
  await ctx.next();
  assert.strictEqual(ctx.currentView(), 'staged:a2.txt:0');
});

test('same path in Staged and Changes: after clicking the Changes copy in the panel, Next continues from there', async () => {
  const { files, staged } = bothGroupsRepo();
  const ctx = setup(files, openNormal, staged);
  await ctx.next();
  assert.strictEqual(ctx.currentView(), 'staged:a2.txt:0');

  // The extension last navigated to the STAGED a2, but the user now opens the
  // Changes copy themselves -- what is on screen wins over the remembered entry.
  await ctx.clickInChanges('a2.txt');
  await ctx.next();
  assert.strictEqual(ctx.currentView(), 'changes:a2.txt:4');
  await ctx.next();
  assert.strictEqual(ctx.currentView(), 'changes:b2.txt:4');
});

test('same path in Staged and Changes: in a plain editor (no diff to tell), Next continues from the entry last moved to', async () => {
  const files = [
    { id: 'a2.txt', hunkLines: [5, 15] },
    { id: 'c.txt', hunkLines: [7] },
  ];
  const staged = [{ id: 'a2.txt', renamedFrom: 'a.txt', hunkLines: [] }];
  const ctx = setup(files, openNormal, staged);
  await ctx.next(); // staged a2
  await ctx.next(); // changes a2, first hunk
  assert.strictEqual(ctx.currentView(), 'changes:a2.txt:4');

  // The file itself is now in front, which doesn't say Staged or Changes.
  ctx.openPlainFile('a2.txt', 4);
  await ctx.next();
  assert.strictEqual(ctx.currentKey(), '/repo/a2.txt:14', 'must continue with the Changes entry, not restart at the staged one');
});

test('status bar: shows the group and the position within it, and follows the active editor', async () => {
  const { files, staged } = bothGroupsRepo();
  const ctx = setup(files, openNormal, staged);

  ctx.openPlainFile('c.txt', 0);
  assert.strictEqual(ctx.statusText(), 'HIDDEN', 'stays hidden until Next/Previous is used');
  ctx.openPlainFile('not-changed.txt', 0); // so the walk below starts at the top of the list

  const seen = [];
  for (let i = 0; i < BOTH_GROUPS_FORWARD.length; i++) {
    await ctx.next();
    seen.push(ctx.statusText());
  }
  assert.deepStrictEqual(seen, ['Staged 1/2', 'Staged 2/2', 'Changes 1/3', 'Changes 2/3', 'Changes 3/3']);

  await ctx.prev(); // back to b2 (Changes)
  assert.strictEqual(ctx.statusText(), 'Changes 2/3');

  await ctx.clickInChanges('a2.txt');
  assert.strictEqual(ctx.statusText(), 'Changes 1/3', 'follows a file opened from the panel');

  ctx.openPlainFile('not-changed.txt', 0);
  assert.strictEqual(ctx.statusText(), 'HIDDEN', 'hidden when the active editor is not a listed change');
});

test('status bar: gitChangesThrough.showPosition=false keeps it hidden', async () => {
  const { files, staged } = bothGroupsRepo();
  const ctx = setup(files, openNormal, staged);
  ctx.state.config['gitChangesThrough.showPosition'] = false;
  await ctx.next();
  assert.strictEqual(ctx.statusText(), 'HIDDEN');
});

test('staged renames: a pure rename takes exactly one press, a rename with edits stops at its real hunks', async () => {
  // `git diff --cached -- <new path>` reports a staged rename as a whole new file,
  // which would give a bogus stop at line 1 and hide the real edits of d2.txt.
  const files = [{ id: 'z.txt', hunkLines: [3] }];
  const staged = [
    { id: 'a2.txt', renamedFrom: 'a.txt', hunkLines: [] },
    { id: 'd2.txt', renamedFrom: 'd.txt', hunkLines: [10, 20] },
  ];
  const ctx = setup(files, openNormal, staged);
  const forward = ['staged:a2.txt:0', 'staged:d2.txt:9', 'staged:d2.txt:19', 'changes:z.txt:2'];
  const seen = [];
  for (let i = 0; i < forward.length; i++) {
    await ctx.next();
    seen.push(ctx.currentView());
  }
  assert.deepStrictEqual(seen, forward);

  const back = [];
  for (let i = 1; i < forward.length; i++) {
    await ctx.prev();
    back.push(ctx.currentView());
  }
  assert.deepStrictEqual(back, forward.slice(0, -1).reverse());
});

test('stress: many random file/hunk layouts never stall or skip, across focus quirks', async (t) => {
  // Each seed/behavior combination is its own reported subtest (not folded into
  // one pass/fail), so a failure names exactly which combination broke and the
  // total test count reflects how many cases were actually checked.
  for (let seed = 1; seed <= 25; seed++) {
    const files = randomFiles(5, seed);
    if (files.every((f) => f.hunkLines.length === 0)) continue; // nothing to walk
    for (const [name, behavior] of Object.entries(behaviors)) {
      await t.test(`seed=${seed} behavior=${name}`, async () => {
        await assertWalksAllHunksForward(files, behavior);
      });
    }
  }
});
