# Changelog

All notable changes to **Git Changes Through Files** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

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
