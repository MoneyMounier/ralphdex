# Codex Ralphy Loop

This VS Code extension runs a Ralph loop by repeatedly starting fresh Codex CLI processes with the bundled prompt in `plan-implement.md`.

## Commands

- `Ralphy: Start Ralph Loop` runs up to `ralphy.maxIterations` iterations.
- `Ralphy: Continue Ralph Loop` asks for the same inputs as start, plus the previous iteration output.
- `Ralphy: Run One Ralph Iteration` runs one fresh Codex iteration.
- `Ralphy: Stop Ralph Loop` terminates the active Codex process and stops the loop.

Output is streamed to the `Ralphy` output channel.

When you start a loop, Ralphy asks for:

- the task file Codex should work from
- the number of fresh Codex iterations to run

When you continue a loop, Ralphy also asks for the last iteration output. If text is selected in the active editor, it can use that selection; otherwise it asks for an output file.

Ralphy inserts the selected task file into every `<taskfile>` placeholder in the bundled `plan-implement.md` before sending the prompt to Codex.
For continued loops, it appends the supplied handoff under `## Last iteration output`. After each successful iteration, Ralphy passes that iteration's summary into the next fresh Codex run.

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
