# Changelog

All notable changes to **Git Changes Through Files** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.5.3] — 2026-10-21

### Fixed
- A file listed under **both** Staged Changes and Changes (staged, then edited again: `MM`, `AM`, `RM` in `git status`) broke navigation. Next jumped back into the Staged group every time it reached such a file, so the end of the list was never reached. Each Source Control entry is now identified by its group and path, not by path alone. Next/Previous visit every entry once, in panel order.
- The staged entry of such a file now opens its staged diff (HEAD ↔ index). Before, `git.openChange` always opened the working-tree diff for it.
- Hunks of the Changes entry of such a file are now read from its working-tree diff, not from the staged diff.
- Staged renames: hunks are now computed between the old and the new path. Before, git reported a staged rename as a whole new file. A pure rename got a bogus stop at line 1, and the real edits of a renamed-and-edited file were never visited. A pure rename now takes exactly one press, which shows its diff, and the next press moves on.

### Added
- Status bar item showing which Source Control entry the active editor is, e.g. **`Staged 7/10`** or **`Changes 3/19`**. It appears once Next/Previous Change has been used and hides when the active editor isn't a listed change. Clicking it shows the Source Control panel. VS Code does not select staged entries in the panel (its `scm.autoReveal` only matches editors showing the file on disk, and extensions can't select a row there), so this is the way to see where you are in the Staged group.
- Setting **`gitChangesThrough.showPosition`** (default `true`) to turn the status bar item off.

## [0.5.2] — 2026-08-03

### Fixed
- Navigation could get permanently stuck re-jumping to the first hunk of the same file instead of advancing, whenever the diff editor wasn't in the currently *focused* editor group (e.g. with a split editor / multiple groups open). `isViewingChange()` now checks the active tab of every visible editor group instead of only the focused one.

### Added
- Setting **`gitChangesThrough.debugLog`** (default `false`) — logs detailed navigation decisions to a file for troubleshooting.
- Command **"Git Changes: Open Debug Log"** — opens the recorded debug log.
- Automated test suite (`npm test`) covering the navigation state machine, including a regression test for the fix above.

## [0.5.0] — 2026-04-03

### Added
- **Next Change** command (`Git Changes: Next Change`) — navigates to the next git diff hunk, crossing into the next changed file when the last hunk of the current file is reached.
- **Previous Change** command (`Git Changes: Previous Change`) — navigates backwards, crossing into the previous changed file when the first hunk is reached.
- File navigation follows the exact order shown in the VS Code Source Control panel (Merge Changes → Staged Changes → Changes).
- Deleted files are included in navigation via their diff view.
- Setting **`gitChangesThrough.closeFileOnMove`** (default `false`) — closes the current editor when moving to a different file.
- Setting **`gitChangesThrough.wrapAround`** (default `false`) — wraps from the last change back to the first and vice versa.
- On first invocation the extension opens the first changed file and jumps to its first hunk (or last hunk when going backwards).
