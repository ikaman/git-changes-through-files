// Minimal mock of the slice of the 'vscode' API this extension actually uses.
// Lets the compiled out/extension.js run under plain Node so navigate() can be
// exercised end-to-end (via the commands it registers) without a real VS Code host.

'use strict';

const path = require('path');
const Module = require('module');

class Position {
  constructor(line, character) { this.line = line; this.character = character || 0; }
}
class Selection {
  constructor(anchor, active) { this.anchor = anchor; this.active = active; }
}
class Range {
  constructor(s, e) { this.start = s; this.end = e; }
}
class UriImpl {
  constructor(fsPath, scheme = 'file', query = '') {
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, '/');
    this.scheme = scheme;
    this.query = query;
  }
  toString() { return `${this.scheme}:${this.path}${this.query ? '?' + this.query : ''}`; }
}
class TabInputTextDiff {
  constructor(original, modified) { this.original = original; this.modified = modified; }
}
class TabInputText {
  constructor(uri) { this.uri = uri; }
}

// Same shape as the git extension's toGitUri(): scheme 'git', same path, and the
// ref ('HEAD' = last commit, '' = index, '~' = index as the base of a working-tree diff)
// in a JSON query.
function toGitUri(uri, ref) {
  return new UriImpl(uri.fsPath, 'git', JSON.stringify({ path: uri.fsPath, ref }));
}

// Two editor groups, 'A' and 'B', modeling e.g. a split editor. Each holds at
// most one tab -- enough to exercise "is the diff open in ANY group" logic.
function initGroups(state) {
  state.groups = { A: { activeTab: undefined }, B: { activeTab: undefined } };
  state.activeGroupId = 'A';
}

function buildTabGroups(state) {
  const all = Object.entries(state.groups).map(([id, g]) => ({
    id,
    viewColumn: id,
    activeTab: g.activeTab,
    tabs: g.activeTab ? [g.activeTab] : [],
  }));
  return { all, activeTabGroup: all.find((g) => g.id === state.activeGroupId) };
}

// What the git extension's `git.openChange <uri>` opens: it looks the path up in the
// working-tree group FIRST, then the index, then merge changes -- so for a path listed
// under both Staged Changes and Changes it always opens the working-tree diff.
function resolveOpenChange(uri, state) {
  const s = state.gitAPI.repositories[0].state;
  const wt = s.workingTreeChanges.find((c) => c.uri.fsPath === uri.fsPath);
  if (wt) return { left: toGitUri(wt.uri, '~'), right: wt.uri };
  const idx = s.indexChanges.find((c) => c.uri.fsPath === uri.fsPath);
  if (idx) return { left: toGitUri(idx.originalUri, 'HEAD'), right: toGitUri(idx.uri, '') };
  return undefined;
}

function makeVscodeMock(state) {
  const listeners = [];

  function fireActiveEditorChanged(editor) {
    for (const cb of [...listeners]) cb(editor);
  }

  state.fireActiveEditorChanged = fireActiveEditorChanged;
  state.statusBarItem = {
    text: '', tooltip: '', command: undefined, visible: false,
    show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {},
  };

  async function show(left, right) {
    state.shown = right;
    await state.openBehavior(left, right, state, fireActiveEditorChanged);
  }

  return {
    Position, Selection, Range,
    Uri: { file: (p) => new UriImpl(p) },
    TabInputTextDiff, TabInputText,
    TextEditorRevealType: { InCenter: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: {
      registerCommand: (name, cb) => { state.commands[name] = cb; return { dispose() {} }; },
      executeCommand: async (cmd, ...args) => {
        state.executedCommands.push(cmd);
        if (cmd === 'workbench.view.scm') return;
        if (cmd === 'workbench.action.closeActiveEditor') {
          state.activeEditor = undefined;
          state.groups.A.activeTab = undefined;
          state.groups.B.activeTab = undefined;
          return;
        }
        if (cmd === 'git.openChange') {
          const target = resolveOpenChange(args[0], state);
          if (target) await show(target.left, target.right);
          return;
        }
        if (cmd === 'vscode.diff') {
          await show(args[0], args[1]);
          return;
        }
      },
    },
    window: {
      get activeTextEditor() { return state.activeEditor; },
      get tabGroups() { return buildTabGroups(state); },
      onDidChangeActiveTextEditor: (cb) => {
        listeners.push(cb);
        return { dispose: () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1); } };
      },
      showInformationMessage: (msg) => { state.messages.push(msg); },
      showWarningMessage: (msg) => { state.messages.push(msg); },
      showErrorMessage: (msg) => { state.messages.push(msg); },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => state.statusBarItem,
    },
    workspace: {
      getConfiguration: (section) => ({
        get: (key, def) => {
          const full = `${section}.${key}`;
          return Object.prototype.hasOwnProperty.call(state.config, full) ? state.config[full] : def;
        },
      }),
      openTextDocument: async () => ({}),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    extensions: {
      getExtension: () => ({ isActive: true, exports: { getAPI: () => state.gitAPI } }),
    },
  };
}

// Build a unified diff with one hunk per entry in hunkLines (1-based new-file line numbers).
function buildDiff(hunkLines) {
  let out = '';
  for (const L of hunkLines) {
    out += `@@ -${L},1 +${L},1 @@\n-old${L}\n+new${L}\n`;
  }
  return out;
}

// Git Status enum values used below (same numbers as the git extension's API).
const INDEX_MODIFIED = 0;
const INDEX_RENAMED = 3;
const MODIFIED = 5;

// files:  working-tree changes ("Changes"), { id, hunkLines }.
// staged: index changes ("Staged Changes"), { id, hunkLines, renamedFrom? }. A staged
//         entry may share its id with a working-tree one (git status "MM" / "RM").
function makeRepo(files, staged) {
  const changes = files.map((f) => ({
    uri: new UriImpl(`/repo/${f.id}`),
    originalUri: new UriImpl(`/repo/${f.id}`),
    renameUri: undefined,
    status: MODIFIED,
  }));
  const indexChanges = staged.map((f) => ({
    uri: new UriImpl(`/repo/${f.id}`),
    originalUri: new UriImpl(`/repo/${f.renamedFrom || f.id}`),
    renameUri: f.renamedFrom ? new UriImpl(`/repo/${f.id}`) : undefined,
    status: f.renamedFrom ? INDEX_RENAMED : INDEX_MODIFIED,
  }));
  return {
    rootUri: new UriImpl('/repo'),
    state: { mergeChanges: [], indexChanges, workingTreeChanges: changes },
    // Real git: `git diff -- <path>` (index vs working tree).
    diffWithHEAD: async (relPath) => {
      const f = files.find((f) => f.id === relPath);
      if (!f || f.hunkLines.length === 0) throw new Error('no diff'); // untracked/binary
      return buildDiff(f.hunkLines);
    },
    // Real git: `git diff --cached -- <path>`. The pathspec hides the old name of a
    // staged rename, so git cannot pair it and reports the whole file as added.
    diffIndexWithHEAD: async (relPath) => {
      const f = staged.find((f) => f.id === relPath);
      if (!f) return '';
      if (f.renamedFrom) return '@@ -0,0 +1,20 @@\n' + '+line\n'.repeat(20);
      return buildDiff(f.hunkLines);
    },
    getObjectDetails: async (treeish, relPath) => ({ mode: '100644', object: `${treeish || ':0'}:${relPath}`, size: 1 }),
    // Blob ids from getObjectDetails() above; the diff is keyed by the new (index) path.
    diffBlobs: async (_before, after) => {
      const id = after.replace(/^:0:/, '');
      const f = staged.find((f) => f.id === id);
      return f ? buildDiff(f.hunkLines) : '';
    },
  };
}

// ---- openBehavior variants: how "opening the diff" affects editor/tab state ----
// Each receives the diff's left (original) and right (modified) URIs.

function makeEditor(uri) {
  return { document: { uri }, selection: new Selection(new Position(0), new Position(0)), revealRange() {} };
}

// Normal: opening focuses the MODIFIED (right) pane in the active group (A).
async function openNormal(left, right, state, fire) {
  const editor = makeEditor(right);
  state.activeEditor = editor;
  state.activeGroupId = 'A';
  state.groups.A.activeTab = { input: new TabInputTextDiff(left, right), isActive: true };
  fire(editor);
}

// Quirk: opening leaves focus on the ORIGINAL (left) pane instead of modified.
async function openFocusOriginal(left, right, state, fire) {
  const editor = makeEditor(left);
  state.activeEditor = editor;
  state.activeGroupId = 'A';
  state.groups.A.activeTab = { input: new TabInputTextDiff(left, right), isActive: true };
  fire(editor);
}

// Regression case for the "stuck on the same file" bug: the diff opens into a
// BACKGROUND group (B) -- e.g. a split editor where group A still has keyboard
// focus elsewhere. Group A's active tab is left untouched/unrelated. The diff is
// genuinely open and visible, just not in the *focused* group.
async function openStaleTabGroup(left, right, state, fire) {
  const editor = makeEditor(right);
  state.activeEditor = editor;
  state.activeGroupId = 'A';
  state.groups.B.activeTab = { input: new TabInputTextDiff(left, right), isActive: true };
  fire(editor);
}

function loadExtension(vscodeMock) {
  const extPath = path.resolve(__dirname, '..', 'out', 'extension.js');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...rest);
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeMock;
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve(extPath)];
  const ext = require(extPath);
  Module._load = origLoad;
  Module._resolveFilename = origResolve;
  return ext;
}

// Sets up a fresh extension instance (its own module-level state) wired to a
// synthetic repo, and returns handles to drive/observe it.
function setup(files, openBehavior, staged = []) {
  const state = {
    executedCommands: [],
    messages: [],
    config: {},
    commands: {},
    openBehavior,
  };
  initGroups(state);
  const vscodeMock = makeVscodeMock(state);
  const ext = loadExtension(vscodeMock);
  const repo = makeRepo(files, staged);
  state.gitAPI = { repositories: [repo], toGitUri };

  ext.activate({ subscriptions: [], logUri: new UriImpl(path.join(__dirname, '.log-out')) });

  return {
    state,
    next: () => state.commands['gitChangesThrough.nextChange'](),
    prev: () => state.commands['gitChangesThrough.previousChange'](),
    // Simulates clicking a file under "Changes" in the Source Control panel.
    clickInChanges: (id) => vscodeMock.commands.executeCommand('git.openChange', new UriImpl(`/repo/${id}`)),
    // Simulates the user opening the file itself (not a diff) in the focused group.
    openPlainFile: (id, line) => {
      const uri = new UriImpl(`/repo/${id}`);
      state.activeEditor = makeEditor(uri);
      state.activeEditor.selection = new Selection(new Position(line), new Position(line));
      state.activeGroupId = 'A';
      state.groups.A.activeTab = { input: new TabInputText(uri), isActive: true };
      state.fireActiveEditorChanged(state.activeEditor);
    },
    // Status bar position text without the icon, or 'HIDDEN'.
    statusText: () => (state.statusBarItem.visible ? state.statusBarItem.text.replace(/^\$\([^)]*\)\s*/, '') : 'HIDDEN'),
    currentKey: () => {
      const e = state.activeEditor;
      return e ? `${e.document.uri.fsPath}:${e.selection.active.line}` : 'NONE';
    },
    // Like currentKey(), but also says WHICH diff of the file is on screen:
    // "staged" (HEAD vs index) or "changes" (index vs working tree).
    currentView: () => {
      const e = state.activeEditor;
      if (!e || !state.shown) return 'NONE';
      const group = state.shown.scheme === 'git' ? 'staged' : 'changes';
      return `${group}:${path.posix.basename(state.shown.path)}:${e.selection.active.line}`;
    },
  };
}

module.exports = {
  setup, buildDiff, UriImpl, toGitUri,
  openNormal, openFocusOriginal, openStaleTabGroup,
};
