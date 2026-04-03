# Git Changes Through Files

Navigate git diff changes **across all changed files** without manually clicking each file in the Source Control panel.

VS Code's built-in *Next Change* / *Previous Change* stays inside the current file. This extension breaks that boundary — when you reach the last hunk in a file it automatically opens the next changed file and jumps to its first hunk. Going backwards works the same way.

---

## Features

- **Cross-file navigation** — moves through every changed file in the order shown in the Source Control panel (Merge Changes → Staged Changes → Changes).
- **Deleted files included** — opens the diff view for deleted files so nothing is skipped.
- **Close on move** — optionally closes the current file when jumping to the next one, keeping your editor tabs clean.
- **Wrap-around** — optionally loops from the last change back to the first (disabled by default).
- **No default keybindings** — assign your own shortcuts via *Keyboard Shortcuts* (`Ctrl+K Ctrl+S`).

---

## Commands

| Command | ID |
|---|---|
| Git Changes: Next Change | `gitChangesThrough.nextChange` |
| Git Changes: Previous Change | `gitChangesThrough.previousChange` |

Search for either command in the Command Palette (`Ctrl+Shift+P`) to run them or to assign a keybinding.

---

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `gitChangesThrough.closeFileOnMove` | boolean | `false` | Close the current editor when navigating to a different changed file. |
| `gitChangesThrough.wrapAround` | boolean | `false` | After the last change of the last file, wrap around to the first file's first change (and vice versa). |

---

## How it works

1. **First invocation** — opens the first changed file in a diff view and jumps to its first hunk. Running *Previous Change* first opens the last file at its last hunk.
2. **Within a file** — behaves like VS Code's built-in diff navigation, moving between hunks.
3. **At the boundary** — when you are at the last hunk of a file and press *Next Change*, the extension moves on to the first hunk of the next changed file. *Previous Change* at the first hunk moves to the last hunk of the previous file.
4. **File selection** — the current file is selected/revealed in the Source Control panel as you navigate.

---


## License

MIT
