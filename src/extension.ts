import * as vscode from 'vscode';
import * as nodePath from 'path';
import * as fs from 'fs';

// ── Minimal git extension API types ───────────────────────────────────────────

interface GitExtension {
    getAPI(version: 1): GitAPI;
}

interface GitAPI {
    repositories: Repository[];
    toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

interface Repository {
    rootUri: vscode.Uri;
    state: RepositoryState;
    /** Despite the name: `git diff -- <path>`, i.e. index vs working tree. */
    diffWithHEAD(path: string): Promise<string>;
    /** `git diff --cached -- <path>`, i.e. HEAD vs index. */
    diffIndexWithHEAD(path: string): Promise<string>;
    /** treeish '' = the index. */
    getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number }>;
    diffBlobs(object1: string, object2: string): Promise<string>;
}

interface RepositoryState {
    mergeChanges: Change[];
    indexChanges: Change[];
    workingTreeChanges: Change[];
}

interface Change {
    uri: vscode.Uri;
    originalUri: vscode.Uri;
    renameUri: vscode.Uri | undefined;
    status: number;
}

// Values of the git extension's Status enum that are handled specially below.
const STATUS_INDEX_ADDED = 1;
const STATUS_INDEX_DELETED = 2;
const STATUS_INDEX_RENAMED = 3;
const STATUS_INDEX_COPIED = 4;

// Which Source Control group an entry is listed under.
type ChangeGroup = 'merge' | 'index' | 'workingTree';

// One row of the Source Control panel. The same file can be listed twice — under
// Staged Changes AND Changes (git status "MM", "AM", "RM") — so a row is
// identified by (group, path), never by path alone.
interface Entry {
    change: Change;
    group: ChangeGroup;
}

function entryKey(entry: Entry): string {
    return `${entry.group}:${entry.change.uri.fsPath}`;
}

// ── Hunk parsing ───────────────────────────────────────────────────────────────

interface Hunk {
    /** 1-based line number of the first actual changed line (+/-) in the new file. */
    firstChangedLine: number;
}

function parseHunks(diffText: string): Hunk[] {
    const hunks: Hunk[] = [];
    const lines = diffText.split('\n');
    let newLine = 0;
    let inHunk = false;
    // Tracks whether the previous line was part of a +/- run, so that a run
    // of changed lines separated from another by context lines counts as a
    // separate stop — a single "@@" hunk can contain several such runs when
    // git merges nearby edits under one shared context window.
    let inChangeRun = false;

    for (const line of lines) {
        const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (header) {
            newLine = parseInt(header[1], 10);
            inHunk = true;
            inChangeRun = false;
            continue;
        }
        if (!inHunk) {
            continue;
        }
        if (line.startsWith('+')) {
            if (!inChangeRun) {
                hunks.push({ firstChangedLine: newLine });
                inChangeRun = true;
            }
            newLine++;
        } else if (line.startsWith('-')) {
            // deleted line — doesn't advance newLine, but marks where the change is
            if (!inChangeRun) {
                hunks.push({ firstChangedLine: newLine });
                inChangeRun = true;
            }
        } else if (line.startsWith(' ')) {
            newLine++;
            inChangeRun = false;
        } else {
            // end of hunk (e.g. "\ No newline at end of file" or next header)
            inHunk = false;
            inChangeRun = false;
        }
    }

    return hunks;
}

// ── Session state ──────────────────────────────────────────────────────────────

// The entry navigation last moved to, as entryKey(). Stored as a key rather than
// an index so it survives the list changing between presses (staging, new files).
let currentEntryKey: string | undefined;
let cachedFiles: Entry[] = [];
let cachedRepoRoot = '';
// The position item stays hidden until Next/Previous is used for the first time.
let hasNavigated = false;

// ── Debug logging ─────────────────────────────────────────────────────────────
// Off by default. When enabled via gitChangesThrough.debugLog, every navigate()
// decision is written to both an output channel and a log file on disk, so a log
// from a real repro can be sent along with a bug report.

let outputChannel: vscode.OutputChannel | undefined;
let logFilePath: string | undefined;

function isDebugLogEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitChangesThrough').get<boolean>('debugLog', false);
}

function log(message: string): void {
    if (!isDebugLogEnabled()) {
        return;
    }
    const line = `[${new Date().toISOString()}] ${message}`;
    outputChannel?.appendLine(line);
    if (logFilePath) {
        try {
            fs.appendFileSync(logFilePath, line + '\n');
        } catch {
            // Best-effort — never let logging break navigation.
        }
    }
}

function describeTabInput(input: unknown): string {
    if (input instanceof vscode.TabInputTextDiff) {
        return `diff(original=${input.original.fsPath}, modified=${input.modified.fsPath})`;
    }
    if (input instanceof vscode.TabInputText) {
        return `text(${input.uri.fsPath})`;
    }
    return 'other';
}

function logTabGroups(): void {
    if (!isDebugLogEnabled()) {
        return;
    }
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    for (const group of vscode.window.tabGroups.all) {
        const marker = group === activeGroup ? '*' : ' ';
        const tabs = group.tabs
            .map(t => `${t.isActive ? '(active-tab)' : ''}${describeTabInput(t.input)}`)
            .join(', ') || '(empty)';
        log(`  ${marker} group[viewColumn=${group.viewColumn}]: ${tabs}`);
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getGitAPI(): GitAPI | undefined {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext?.isActive) {
        return undefined;
    }
    return ext.exports.getAPI(1);
}

function getRepo(git: GitAPI): Repository | undefined {
    if (git.repositories.length === 0) {
        return undefined;
    }
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activePath && git.repositories.length > 1) {
        return (
            git.repositories.find(r => activePath.startsWith(r.rootUri.fsPath)) ??
            git.repositories[0]
        );
    }
    return git.repositories[0];
}

// ── SCM panel sort ─────────────────────────────────────────────────────────────
// Replicates the order VS Code displays files in the Source Control panel.
// List view: files (leaves) sort before deeper paths at the same level.
// Tree view: folders sort before files at the same level.

function comparePathsForListView(a: string, b: string): number {
    const partsA = a.toLowerCase().split('/');
    const partsB = b.toLowerCase().split('/');

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const pa = partsA[i];
        const pb = partsB[i];
        if (pa === pb) { continue; }
        const aIsLeaf = i === partsA.length - 1;
        const bIsLeaf = i === partsB.length - 1;
        if (aIsLeaf && bIsLeaf) { return pa < pb ? -1 : 1; }
        if (i < partsA.length - 1 && i < partsB.length - 1) { return pa < pb ? -1 : 1; }
        // file (leaf) before folder
        return aIsLeaf ? -1 : 1;
    }
    return 0;
}

function comparePathsForTreeView(a: string, b: string): number {
    const partsA = a.toLowerCase().split('/');
    const partsB = b.toLowerCase().split('/');

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const pa = partsA[i];
        const pb = partsB[i];
        if (pa === pb) { continue; }
        const aIsLeaf = i === partsA.length - 1;
        const bIsLeaf = i === partsB.length - 1;
        if (aIsLeaf && bIsLeaf) { return pa < pb ? -1 : 1; }
        if (i < partsA.length - 1 && i < partsB.length - 1) { return pa < pb ? -1 : 1; }
        // folder before file
        return aIsLeaf ? 1 : -1;
    }
    return 0;
}

function sortChanges(changes: Change[], treeView: boolean): Change[] {
    return [...changes].sort((a, b) => {
        const pathA = a.uri.path;
        const pathB = b.uri.path;
        return treeView
            ? comparePathsForTreeView(pathA, pathB)
            : comparePathsForListView(pathA, pathB);
    });
}

function isScmTreeView(): boolean {
    return vscode.workspace.getConfiguration('scm').get<string>('defaultViewMode') === 'tree';
}

function getAllChanges(repo: Repository): Entry[] {
    const treeView = isScmTreeView();
    const inGroup = (group: ChangeGroup) => (change: Change): Entry => ({ change, group });
    return [
        ...repo.state.mergeChanges.map(inGroup('merge')),
        ...sortChanges(repo.state.indexChanges, treeView).map(inGroup('index')),
        ...sortChanges(repo.state.workingTreeChanges, treeView).map(inGroup('workingTree')),
    ];
}

function relativePath(repo: Repository, uri: vscode.Uri): string {
    return nodePath.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

// The hunks must come from the same diff the editor shows for this entry: a staged
// entry compares HEAD with the index, a working-tree entry the index with the file
// on disk. The group decides which — not whether the path is staged at all, since a
// file listed under both groups is staged for its Changes entry too.
async function getDiffForEntry(repo: Repository, entry: Entry): Promise<string> {
    const { change } = entry;
    const relPath = relativePath(repo, change.uri);
    if (entry.group !== 'index') {
        return repo.diffWithHEAD(relPath);
    }
    if (change.status === STATUS_INDEX_RENAMED) {
        // `git diff --cached -- <new path>` can't pair a rename (the pathspec filters
        // out the old path), so it reports the whole file as added: a bogus stop at
        // line 1 for a pure rename, and the real edits of a rename+edit lost. Diff the
        // two blobs instead — the same HEAD(old path) vs index(new path) pair the diff
        // editor shows. A pure rename then has no hunks at all.
        try {
            const [before, after] = await Promise.all([
                repo.getObjectDetails('HEAD', relativePath(repo, change.originalUri)),
                repo.getObjectDetails('', relPath),
            ]);
            return await repo.diffBlobs(before.object, after.object);
        } catch (err) {
            log(`blob diff for staged rename failed (${err}) — falling back to diffIndexWithHEAD`);
        }
    }
    return repo.diffIndexWithHEAD(relPath);
}

async function getHunksForChange(repo: Repository, entry: Entry): Promise<Hunk[]> {
    try {
        return parseHunks(await getDiffForEntry(repo, entry));
    } catch {
        return [];
    }
}

// `git.openChange <uri>` looks the path up under Changes FIRST and only then under
// Staged Changes, so for a file listed in both it always opens the working-tree diff.
// For the staged entry of such a file, open its diff ourselves with the same URIs and
// title the git extension uses for a staged entry.
async function openEntry(entry: Entry, repo: Repository, git: GitAPI): Promise<void> {
    const { change } = entry;
    const alsoInWorkingTree = repo.state.workingTreeChanges.some(
        c => c.uri.fsPath === change.uri.fsPath
    );
    if (entry.group !== 'index' || !alsoInWorkingTree) {
        await vscode.commands.executeCommand('git.openChange', change.uri);
        return;
    }
    const name = nodePath.basename(change.uri.fsPath);
    if (change.status === STATUS_INDEX_DELETED) {
        await vscode.commands.executeCommand('vscode.open', git.toGitUri(change.uri, 'HEAD'), {}, `${name} (Deleted)`);
    } else if (change.status === STATUS_INDEX_ADDED || change.status === STATUS_INDEX_COPIED) {
        // Nothing in HEAD to compare against — the git extension shows the index version alone.
        await vscode.commands.executeCommand('vscode.open', git.toGitUri(change.uri, ''), {}, `${name} (Index)`);
    } else {
        await vscode.commands.executeCommand(
            'vscode.diff',
            git.toGitUri(change.originalUri, 'HEAD'),
            git.toGitUri(change.uri, ''),
            `${name} (Index)`,
        );
    }
}

function jumpToHunk(editor: vscode.TextEditor, hunk: Hunk): void {
    const pos = new vscode.Position(Math.max(0, hunk.firstChangedLine - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function openDiffAndJumpToHunk(
    entry: Entry,
    repo: Repository,
    git: GitAPI,
    goToLast: boolean,
): Promise<void> {
    // Fetch hunks BEFORE opening so we can position immediately on editor activation.
    const hunks = await getHunksForChange(repo, entry);
    const targetHunk = hunks.length > 0
        ? (goToLast ? hunks[hunks.length - 1] : hunks[0])
        : null;

    let positioned = false;

    // Register listener before opening so we catch the very first render.
    const disposable = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && !positioned) {
            positioned = true;
            disposable.dispose();
            if (targetHunk) {
                jumpToHunk(editor, targetHunk);
            }
        }
    });

    await openEntry(entry, repo, git);

    // If the diff was already open in the active tab, no change event fires — position now.
    if (!positioned) {
        disposable.dispose();
        const editor = vscode.window.activeTextEditor;
        if (editor && targetHunk) {
            jumpToHunk(editor, targetHunk);
        }
    }
}

function gitRef(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'git') {
        return undefined;
    }
    try {
        return JSON.parse(uri.query).ref;
    } catch {
        return undefined;
    }
}

// Which group's diff a tab shows, when the tab can tell: the modified side of a
// staged diff is the index version (a git: URI with ref ''), that of a working-tree
// diff is the file on disk. undefined when it can't tell (a plain editor, a deleted
// file's read-only preview, ...).
function groupShownByTab(input: unknown): ChangeGroup | undefined {
    if (input instanceof vscode.TabInputTextDiff) {
        if (input.modified.scheme === 'file') {
            return 'workingTree';
        }
        return gitRef(input.modified) === '' ? 'index' : undefined;
    }
    if (input instanceof vscode.TabInputText) {
        // A staged new/copied file is shown alone, as its index version.
        return gitRef(input.uri) === '' ? 'index' : undefined;
    }
    return undefined;
}

function tabShowsPath(input: unknown, fsPath: string): boolean {
    if (input instanceof vscode.TabInputTextDiff) {
        return input.modified.fsPath === fsPath || input.original.fsPath === fsPath;
    }
    if (input instanceof vscode.TabInputText) {
        return input.uri.fsPath === fsPath;
    }
    return false;
}

// Group shown by the tab displaying `fsPath`: the focused editor group's active tab
// first, then those of the other visible groups (split editor).
function groupShownFor(fsPath: string): ChangeGroup | undefined {
    const { activeTabGroup, all } = vscode.window.tabGroups;
    for (const group of [activeTabGroup, ...all.filter(g => g !== activeTabGroup)]) {
        const input = group.activeTab?.input;
        if (input && tabShowsPath(input, fsPath)) {
            const shown = groupShownByTab(input);
            if (shown) {
                return shown;
            }
        }
    }
    return undefined;
}

function findActiveFileIndex(files: Entry[]): number {
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!activePath) {
        return -1;
    }
    const matches = files.filter(
        e => e.change.uri.fsPath === activePath || e.change.originalUri?.fsPath === activePath
    );
    if (matches.length <= 1) {
        return matches.length === 1 ? files.indexOf(matches[0]) : -1;
    }
    // The file is listed under both Staged Changes and Changes. The diff on screen
    // says which entry we're on (it wins, so a copy the user clicked in the panel is
    // honoured); if it can't tell, stay on the entry we last moved to.
    const shown = groupShownFor(activePath);
    const match = matches.find(e => e.group === shown)
        ?? matches.find(e => entryKey(e) === currentEntryKey)
        ?? matches[0];
    log(`active path is listed ${matches.length}x; tab shows group=${shown ?? '?'} -> ${entryKey(match)}`);
    return files.indexOf(match);
}

// Deleted files have no "modified" side to diff against, so `git.openChange`
// opens a plain read-only preview of the original content instead of a two-pane
// diff — match that case too, or navigation would think the diff was never
// opened and keep re-opening the same file forever instead of advancing.
// Checks the *active tab of every visible editor group*, not just the group that
// currently has keyboard focus. If we only checked the focused group, a split
// editor (or focus having moved anywhere else — the SCM tree, a terminal, ...)
// would make us think the diff was never opened, and we'd re-open it and jump
// back to its FIRST hunk over and over instead of advancing — the file would
// appear stuck forever on the same spot.
// A diff of the same file from the OTHER group (Staged Changes vs Changes) doesn't
// count — its hunks are different ones.
function isViewingChange(entry: Entry): boolean {
    const { change } = entry;
    for (const group of vscode.window.tabGroups.all) {
        const tab = group.activeTab;
        if (!tab) {
            continue;
        }
        const shown = groupShownByTab(tab.input);
        if (shown && entry.group !== 'merge' && shown !== entry.group) {
            continue;
        }
        if (tab.input instanceof vscode.TabInputTextDiff) {
            if (tab.input.modified.fsPath === change.uri.fsPath
                || tab.input.original.fsPath === change.originalUri?.fsPath) {
                return true;
            }
        } else if (tab.input instanceof vscode.TabInputText) {
            if (tab.input.uri.fsPath === change.uri.fsPath
                || tab.input.uri.fsPath === change.originalUri?.fsPath) {
                return true;
            }
        }
    }
    return false;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Core navigation logic ──────────────────────────────────────────────────────

async function navigate(direction: 'next' | 'prev'): Promise<void> {
    log(`navigate(${direction}) called. currentEntry(before)=${currentEntryKey ?? 'none'}`);
    const git = getGitAPI();
    if (!git) {
        vscode.window.showErrorMessage('Git Changes Through Files: Git extension is not available.');
        return;
    }

    const repo = getRepo(git);
    if (!repo) {
        vscode.window.showWarningMessage('Git Changes Through Files: No git repository found.');
        return;
    }

    hasNavigated = true;

    // Always reveal the SCM panel so the user can see which file is active.
    await vscode.commands.executeCommand('workbench.view.scm');

    // Reset state when the active repo changes.
    if (repo.rootUri.fsPath !== cachedRepoRoot) {
        cachedRepoRoot = repo.rootUri.fsPath;
        currentEntryKey = undefined;
    }

    cachedFiles = getAllChanges(repo);

    if (cachedFiles.length === 0) {
        vscode.window.showInformationMessage('Git Changes Through Files: No changes found.');
        return;
    }

    // Sync to whatever is actually open in the editor; if that isn't a listed
    // change, stay on the entry we last moved to (if it's still listed).
    const editorIdx = findActiveFileIndex(cachedFiles);
    const currentFileIndex = editorIdx !== -1
        ? editorIdx
        : cachedFiles.findIndex(e => entryKey(e) === currentEntryKey);
    log(`editorIdx=${editorIdx}, currentFileIndex(synced)=${currentFileIndex}, cachedFiles=${cachedFiles.length}`);

    const cfg = vscode.workspace.getConfiguration('gitChangesThrough');
    const wrapAround = cfg.get<boolean>('wrapAround', false);
    const closeOnMove = cfg.get<boolean>('closeFileOnMove', false);

    // ── Try to navigate within the current file first ──────────────────────────
    if (currentFileIndex !== -1) {
        const currentFile = cachedFiles[currentFileIndex];
        log(`considering current file: ${entryKey(currentFile)}`);
        // If we're in a regular editor (not a diff view), open the diff for this
        // file first — don't treat it as "already past the last hunk".
        const hunks = await getHunksForChange(repo, currentFile);
        log(`hunks for current file: [${hunks.map(h => h.firstChangedLine).join(', ')}]`);

        if (hunks.length === 0) {
            // Its diff was shown by the press that moved here, so this press moves on.
            log('no hunks (untracked/binary/pure rename) — falling through to next file');
        } else if (!isViewingChange(currentFile)) {
            log('isViewingChange=false — re-opening diff and jumping to first/last hunk. Tab groups at this moment:');
            logTabGroups();
            await openDiffAndJumpToHunk(currentFile, repo, git, direction === 'prev');
            return;
        } else {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const cursorLine = editor.selection.active.line + 1;
                log(`isViewingChange=true, cursorLine=${cursorLine}, activeEditor.uri=${editor.document.uri.fsPath}`);
                if (direction === 'next') {
                    const next = hunks.find(h => h.firstChangedLine > cursorLine);
                    if (next) { log(`jumping to next hunk at line ${next.firstChangedLine}`); jumpToHunk(editor, next); return; }
                } else {
                    const prev = [...hunks].reverse().find(h => h.firstChangedLine < cursorLine);
                    if (prev) { log(`jumping to previous hunk at line ${prev.firstChangedLine}`); jumpToHunk(editor, prev); return; }
                }
                log('no further hunk in this file in that direction — moving to next/previous file');
            } else {
                log('isViewingChange=true but vscode.window.activeTextEditor is undefined — moving to next/previous file');
            }
        }
    }

    // ── Move to the next / previous file ──────────────────────────────────────
    let nextIdx: number;
    if (currentFileIndex === -1) {
        // First invocation — jump to the first or last file.
        nextIdx = direction === 'next' ? 0 : cachedFiles.length - 1;
    } else {
        nextIdx = currentFileIndex + (direction === 'next' ? 1 : -1);
    }

    if (nextIdx >= cachedFiles.length) {
        if (wrapAround) {
            nextIdx = 0;
        } else {
            log('already at the last change — nothing to do');
            vscode.window.showInformationMessage('Git Changes Through Files: Already at the last change.');
            return;
        }
    }
    if (nextIdx < 0) {
        if (wrapAround) {
            nextIdx = cachedFiles.length - 1;
        } else {
            log('already at the first change — nothing to do');
            vscode.window.showInformationMessage('Git Changes Through Files: Already at the first change.');
            return;
        }
    }

    if (closeOnMove && currentFileIndex !== -1) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await delay(50);
    }

    const target = cachedFiles[nextIdx];
    currentEntryKey = entryKey(target);
    log(`moving to file index ${nextIdx}: ${entryKey(target)}`);
    await openDiffAndJumpToHunk(target, repo, git, direction === 'prev');
}

// ── Status bar ─────────────────────────────────────────────────────────────────
// Shows which Source Control entry the active editor is, e.g. "Staged 7/10". The
// panel can't show it for staged entries: VS Code's scm.autoReveal only matches an
// editor showing the file on disk, never a staged (index) diff, and there is no API
// to select a row in the Source Control view from an extension.

let statusBarItem: vscode.StatusBarItem | undefined;

const GROUP_LABELS: Record<ChangeGroup, { short: string; long: string }> = {
    merge: { short: 'Merge', long: 'Merge Changes' },
    index: { short: 'Staged', long: 'Staged Changes' },
    workingTree: { short: 'Changes', long: 'Changes' },
};

function updateStatusBar(): void {
    if (!statusBarItem) {
        return;
    }
    const enabled = vscode.workspace.getConfiguration('gitChangesThrough').get<boolean>('showPosition', true);
    const git = enabled && hasNavigated ? getGitAPI() : undefined;
    const repo = git ? getRepo(git) : undefined;
    const files = repo ? getAllChanges(repo) : [];
    const idx = findActiveFileIndex(files);
    if (!repo || idx === -1) {
        statusBarItem.hide();
        return;
    }
    const entry = files[idx];
    const sameGroup = files.filter(e => e.group === entry.group);
    const label = GROUP_LABELS[entry.group];
    statusBarItem.text = `$(git-compare) ${label.short} ${sameGroup.indexOf(entry) + 1}/${sameGroup.length}`;
    statusBarItem.tooltip = `${label.long}: ${relativePath(repo, entry.change.uri)}\n`
        + `Entry ${idx + 1} of ${files.length} in Source Control. Click to show the panel.`;
    statusBarItem.show();
}

// ── Extension lifecycle ────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Git Changes Through Files');
    context.subscriptions.push(outputChannel);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = 'workbench.view.scm';
    context.subscriptions.push(
        statusBarItem,
        vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gitChangesThrough.showPosition')) {
                updateStatusBar();
            }
        }),
    );

    try {
        fs.mkdirSync(context.logUri.fsPath, { recursive: true });
        logFilePath = nodePath.join(context.logUri.fsPath, 'navigation-debug.log');
    } catch {
        logFilePath = undefined;
    }

    context.subscriptions.push(
        // Also refresh the status bar after a press that only moved between hunks
        // (no editor change event) or that opened an already active diff.
        vscode.commands.registerCommand('gitChangesThrough.nextChange', () => navigate('next').finally(updateStatusBar)),
        vscode.commands.registerCommand('gitChangesThrough.previousChange', () => navigate('prev').finally(updateStatusBar)),
        vscode.commands.registerCommand('gitChangesThrough.openDebugLog', async () => {
            if (!isDebugLogEnabled()) {
                vscode.window.showWarningMessage(
                    'Git Changes Through Files: Enable "gitChangesThrough.debugLog" in settings first, then reproduce the issue.'
                );
                return;
            }
            if (!logFilePath || !fs.existsSync(logFilePath)) {
                vscode.window.showInformationMessage('Git Changes Through Files: No log recorded yet — trigger Next/Previous Change first.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logFilePath));
            await vscode.window.showTextDocument(doc);
        }),
    );
}

export function deactivate(): void {}
