# Ralphdex

This VS Code extension runs a Ralph loop by repeatedly starting fresh Codex CLI processes with the bundled prompt in `plan-implement.md`.

## Commands

- `Ralphdex: Start Ralph Loop` runs up to `ralphdex.maxIterations` iterations.
- `Ralphdex: Continue Ralph Loop` asks for the same inputs as start, then resumes from the matching progress ledger.
- `Ralphdex: Run One Ralph Iteration` runs one fresh Codex iteration.
- `Ralphdex: End Loop After Current Iteration` lets the active Codex iteration finish, records its output, then stops before starting another iteration.
- `Ralphdex: Stop Ralph Loop` terminates the active Codex process and stops the loop.

Output is streamed to the `Ralphdex` output channel.

## UI

Ralphdex adds an activity bar view named `Ralphdex`. Open it from the activity bar or run `Ralphdex: Open Controls`.

The control view lets you:

- choose the task file
- set the iteration count
- start or continue a loop
- run one iteration
- end after the current iteration or stop the active Codex process
- open the progress ledger or output channel

When you start a loop, Ralphdex asks for:

- the task file Codex should work from
- the number of fresh Codex iterations to run

When you continue a loop, Ralphdex loads the matching progress ledger beside the selected task file. If the ledger does not exist, the command exits with an error.

Ralphdex inserts the selected task file into every `<taskfile>` placeholder in the bundled `plan-implement.md` before sending the prompt to Codex.
It also creates a progress ledger beside the task file named `<task-name>.ralphdex-progress.md`, inserts that path into every `<progressfile>` placeholder, and appends each captured iteration summary to the ledger.
For continued loops, it appends the loaded ledger under `## Last iteration output`. After each successful iteration, Ralphdex passes that iteration's summary into the next fresh Codex run.

## Settings

- `ralphdex.taskPath`: optional workspace-relative default task file used if the picker is cancelled.
- `ralphdex.codexCommand`: command used to start Codex. Defaults to `codex`.
- `ralphdex.codexArgs`: arguments passed to Codex. Supports `${workspaceFolder}`, `${promptPath}`, and `${prompt}` placeholders.
- `ralphdex.sendPromptToStdin`: send the prompt file contents over stdin. Enabled by default.
- `ralphdex.maxIterations`: maximum iterations for `Ralphdex: Start Ralph Loop`.
- `ralphdex.stopWhenNoGapRemaining`: stop when the summary reports no next gap.

The default invocation is:

```text
codex exec --cd ${workspaceFolder} -
```

Adjust `ralphdex.codexArgs` if your local Codex CLI uses a different interface.

## Packaging

Build a VSIX package from the extension root with:

```powershell
npx @vscode/vsce package
```
