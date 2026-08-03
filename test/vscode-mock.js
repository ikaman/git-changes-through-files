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
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, '/');
    this.scheme = 'file';
  }
  toString() { return this.path; }
}
class TabInputTextDiff {
  constructor(original, modified) { this.original = original; this.modified = modified; }
}
class TabInputText {
  constructor(uri) { this.uri = uri; }
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

function makeVscodeMock(state) {
  const listeners = [];

  function fireActiveEditorChanged(editor) {
    for (const cb of [...listeners]) cb(editor);
  }

  return {
    Position, Selection, Range,
    Uri: { file: (p) => new UriImpl(p) },
    TabInputTextDiff, TabInputText,
    TextEditorRevealType: { InCenter: 1 },
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
          await state.openBehavior(args[0], state, fireActiveEditorChanged);
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
    },
    workspace: {
      getConfiguration: (section) => ({
        get: (key, def) => {
          const full = `${section}.${key}`;
          return Object.prototype.hasOwnProperty.call(state.config, full) ? state.config[full] : def;
        },
      }),
      openTextDocument: async () => ({}),
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

function makeRepo(files, state) {
  const changes = files.map((f) => ({
    uri: new UriImpl(`/repo/${f.id}`),
    originalUri: new UriImpl(`/repo/${f.id}`),
    renameUri: undefined,
    status: 0,
  }));
  return {
    rootUri: new UriImpl('/repo'),
    state: { mergeChanges: [], indexChanges: [], workingTreeChanges: changes },
    diffWithHEAD: async (relPath) => {
      const f = files.find((f) => f.id === relPath);
      if (!f || f.hunkLines.length === 0) throw new Error('no diff'); // untracked/binary
      return buildDiff(f.hunkLines);
    },
    diffIndexWithHEAD: async () => '',
  };
}

// ---- openBehavior variants: how "opening the diff" affects editor/tab state ----

// Normal: opening focuses the MODIFIED (right) pane in the active group (A).
async function openNormal(uri, state, fire) {
  const change = state.changesByUri.get(uri.fsPath);
  const editor = { document: { uri: change.uri }, selection: new Selection(new Position(0), new Position(0)), revealRange() {} };
  state.activeEditor = editor;
  state.activeGroupId = 'A';
  state.groups.A.activeTab = { input: new TabInputTextDiff(change.originalUri, change.uri), isActive: true };
  fire(editor);
}

// Quirk: opening leaves focus on the ORIGINAL (left, HEAD) pane instead of modified.
async function openFocusOriginal(uri, state, fire) {
  const change = state.changesByUri.get(uri.fsPath);
  const editor = { document: { uri: change.originalUri }, selection: new Selection(new Position(0), new Position(0)), revealRange() {} };
  state.activeEditor = editor;
  state.activeGroupId = 'A';
  state.groups.A.activeTab = { input: new TabInputTextDiff(change.originalUri, change.uri), isActive: true };
  fire(editor);
}

// Regression case for the "stuck on the same file" bug: the diff opens into a
// BACKGROUND group (B) -- e.g. a split editor where group A still has keyboard
// focus elsewhere. Group A's active tab is left untouched/unrelated. The diff is
// genuinely open and visible, just not in the *focused* group.
async function openStaleTabGroup(uri, state, fire) {
  const change = state.changesByUri.get(uri.fsPath);
  const editor = { document: { uri: change.uri }, selection: new Selection(new Position(0), new Position(0)), revealRange() {} };
  state.activeEditor = editor;
  state.activeGroupId = 'A';
  state.groups.B.activeTab = { input: new TabInputTextDiff(change.originalUri, change.uri), isActive: true };
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
function setup(files, openBehavior) {
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
  const repo = makeRepo(files, state);
  state.gitAPI = { repositories: [repo] };
  state.changesByUri = new Map(repo.state.workingTreeChanges.map((c) => [c.uri.fsPath, c]));

  ext.activate({ subscriptions: [], logUri: new UriImpl(path.join(__dirname, '.log-out')) });

  return {
    state,
    next: () => state.commands['gitChangesThrough.nextChange'](),
    prev: () => state.commands['gitChangesThrough.previousChange'](),
    currentKey: () => {
      const e = state.activeEditor;
      return e ? `${e.document.uri.fsPath}:${e.selection.active.line}` : 'NONE';
    },
  };
}

module.exports = {
  setup, buildDiff, UriImpl,
  openNormal, openFocusOriginal, openStaleTabGroup,
};
