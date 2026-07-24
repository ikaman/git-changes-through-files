import * as vscode from 'vscode';
import * as nodePath from 'path';

// ── Minimal git extension API types ───────────────────────────────────────────

interface GitExtension {
    getAPI(version: 1): GitAPI;
}

interface GitAPI {
    repositories: Repository[];
}

interface Repository {
    rootUri: vscode.Uri;
    state: RepositoryState;
    diffWithHEAD(path: string): Promise<string>;
    diffIndexWithHEAD(path: string): Promise<string>;
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

let currentFileIndex = -1;
let cachedFiles: Change[] = [];
let cachedRepoRoot = '';

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

function getAllChanges(repo: Repository): Change[] {
    const treeView = isScmTreeView();
    return [
        ...repo.state.mergeChanges,
        ...sortChanges(repo.state.indexChanges, treeView),
        ...sortChanges(repo.state.workingTreeChanges, treeView),
    ];
}

async function getHunksForChange(repo: Repository, change: Change): Promise<Hunk[]> {
    try {
        const relPath = nodePath
            .relative(repo.rootUri.fsPath, change.uri.fsPath)
            .replace(/\\/g, '/');
        const isStaged = repo.state.indexChanges.some(
            c => c.uri.fsPath === change.uri.fsPath
        );
        const diff = isStaged
            ? await repo.diffIndexWithHEAD(relPath)
            : await repo.diffWithHEAD(relPath);
        return parseHunks(diff);
    } catch {
        return [];
    }
}

function jumpToHunk(editor: vscode.TextEditor, hunk: Hunk): void {
    const pos = new vscode.Position(Math.max(0, hunk.firstChangedLine - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function openDiffAndJumpToHunk(
    change: Change,
    repo: Repository,
    goToLast: boolean,
): Promise<void> {
    // Fetch hunks BEFORE opening so we can position immediately on editor activation.
    const hunks = await getHunksForChange(repo, change);
    const targetHunk = hunks.length > 0
        ? (goToLast ? hunks[hunks.length - 1] : hunks[0])
        : null;

    let positioned = false;

    // Register listener before git.openChange so we catch the very first render.
    const disposable = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && !positioned) {
            positioned = true;
            disposable.dispose();
            if (targetHunk) {
                jumpToHunk(editor, targetHunk);
            }
        }
    });

    await vscode.commands.executeCommand('git.openChange', change.uri);

    // If the diff was already open in the active tab, no change event fires — position now.
    if (!positioned) {
        disposable.dispose();
        const editor = vscode.window.activeTextEditor;
        if (editor && targetHunk) {
            jumpToHunk(editor, targetHunk);
        }
    }
}

function findActiveFileIndex(files: Change[]): number {
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!activePath) {
        return -1;
    }
    return files.findIndex(
        c => c.uri.fsPath === activePath || c.originalUri?.fsPath === activePath
    );
}

// Deleted files have no "modified" side to diff against, so `git.openChange`
// opens a plain read-only preview of the original content instead of a two-pane
// diff — match that case too, or navigation would think the diff was never
// opened and keep re-opening the same file forever instead of advancing.
function isViewingChange(change: Change): boolean {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!tab) {
        return false;
    }
    if (tab.input instanceof vscode.TabInputTextDiff) {
        return tab.input.modified.fsPath === change.uri.fsPath
            || tab.input.original.fsPath === change.originalUri?.fsPath;
    }
    if (tab.input instanceof vscode.TabInputText) {
        return tab.input.uri.fsPath === change.uri.fsPath
            || tab.input.uri.fsPath === change.originalUri?.fsPath;
    }
    return false;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Core navigation logic ──────────────────────────────────────────────────────

async function navigate(direction: 'next' | 'prev'): Promise<void> {
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

    // Always reveal the SCM panel so the user can see which file is active.
    await vscode.commands.executeCommand('workbench.view.scm');

    // Reset state when the active repo changes.
    if (repo.rootUri.fsPath !== cachedRepoRoot) {
        cachedRepoRoot = repo.rootUri.fsPath;
        currentFileIndex = -1;
    }

    cachedFiles = getAllChanges(repo);

    if (cachedFiles.length === 0) {
        vscode.window.showInformationMessage('Git Changes Through Files: No changes found.');
        return;
    }

    // Sync currentFileIndex to whatever is actually open in the editor.
    const editorIdx = findActiveFileIndex(cachedFiles);
    if (editorIdx !== -1) {
        currentFileIndex = editorIdx;
    }

    const cfg = vscode.workspace.getConfiguration('gitChangesThrough');
    const wrapAround = cfg.get<boolean>('wrapAround', false);
    const closeOnMove = cfg.get<boolean>('closeFileOnMove', false);

    // ── Try to navigate within the current file first ──────────────────────────
    if (currentFileIndex !== -1) {
        // If we're in a regular editor (not a diff view), open the diff for this
        // file first — don't treat it as "already past the last hunk".
        const hunks = await getHunksForChange(repo, cachedFiles[currentFileIndex]);

        if (hunks.length === 0) {
            // No parseable diff (untracked / binary) — fall through to next file.
        } else if (!isViewingChange(cachedFiles[currentFileIndex])) {
            await openDiffAndJumpToHunk(cachedFiles[currentFileIndex], repo, direction === 'prev');
            return;
        } else {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const cursorLine = editor.selection.active.line + 1;
                if (direction === 'next') {
                    const next = hunks.find(h => h.firstChangedLine > cursorLine);
                    if (next) { jumpToHunk(editor, next); return; }
                } else {
                    const prev = [...hunks].reverse().find(h => h.firstChangedLine < cursorLine);
                    if (prev) { jumpToHunk(editor, prev); return; }
                }
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
            vscode.window.showInformationMessage('Git Changes Through Files: Already at the last change.');
            return;
        }
    }
    if (nextIdx < 0) {
        if (wrapAround) {
            nextIdx = cachedFiles.length - 1;
        } else {
            vscode.window.showInformationMessage('Git Changes Through Files: Already at the first change.');
            return;
        }
    }

    if (closeOnMove && currentFileIndex !== -1) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await delay(50);
    }

    currentFileIndex = nextIdx;
    await openDiffAndJumpToHunk(cachedFiles[currentFileIndex], repo, direction === 'prev');
}

// ── Extension lifecycle ────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('gitChangesThrough.nextChange', () => navigate('next')),
        vscode.commands.registerCommand('gitChangesThrough.previousChange', () => navigate('prev')),
    );
}

export function deactivate(): void {}
