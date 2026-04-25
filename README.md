# Codex Ralphy Loop

This VS Code extension runs a Ralph loop by repeatedly starting fresh Codex CLI processes with the bundled prompt in `plan-implement.md`.

## Commands

- `Ralphy: Start Ralph Loop` runs up to `ralphy.maxIterations` iterations.
- `Ralphy: Continue Ralph Loop` asks for the same inputs as start, then resumes from the matching progress ledger.
- `Ralphy: Run One Ralph Iteration` runs one fresh Codex iteration.
- `Ralphy: Stop Ralph Loop` terminates the active Codex process and stops the loop.

Output is streamed to the `Ralphy` output channel.

When you start a loop, Ralphy asks for:

- the task file Codex should work from
- the number of fresh Codex iterations to run

When you continue a loop, Ralphy loads the matching progress ledger beside the selected task file. If the ledger does not exist, the command exits with an error.

Ralphy inserts the selected task file into every `<taskfile>` placeholder in the bundled `plan-implement.md` before sending the prompt to Codex.
It also creates a progress ledger beside the task file named `<task-name>.ralphy-progress.md`, inserts that path into every `<progressfile>` placeholder, and appends each captured iteration summary to the ledger.
For continued loops, it appends the loaded ledger under `## Last iteration output`. After each successful iteration, Ralphy passes that iteration's summary into the next fresh Codex run.

## Settings

- `ralphy.taskPath`: optional workspace-relative default task file used if the picker is cancelled.
- `ralphy.codexCommand`: command used to start Codex. Defaults to `codex`.
- `ralphy.codexArgs`: arguments passed to Codex. Supports `${workspaceFolder}`, `${promptPath}`, and `${prompt}` placeholders.
- `ralphy.sendPromptToStdin`: send the prompt file contents over stdin. Enabled by default.
- `ralphy.maxIterations`: maximum iterations for `Ralphy: Start Ralph Loop`.
- `ralphy.stopWhenNoGapRemaining`: stop when the summary reports no next gap.

The default invocation is:

```text
codex exec --cd ${workspaceFolder} -
```

Adjust `ralphy.codexArgs` if your local Codex CLI uses a different interface.
