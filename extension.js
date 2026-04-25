const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

let activeRun = undefined;
let extensionRoot = undefined;

function activate(context) {
  extensionRoot = context.extensionUri.fsPath;
  const output = vscode.window.createOutputChannel('Ralphdex');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'ralphdex.startLoop';
  status.text = '$(sync) Ralphdex';
  status.tooltip = 'Start Ralph loop';
  status.show();

  context.subscriptions.push(output, status);
  context.subscriptions.push(vscode.commands.registerCommand('ralphdex.startLoop', () => startLoop(output, status)));
  context.subscriptions.push(vscode.commands.registerCommand('ralphdex.continueLoop', () => continueLoop(output, status)));
  context.subscriptions.push(vscode.commands.registerCommand('ralphdex.runIteration', () => runSingleIteration(output, status)));
  context.subscriptions.push(vscode.commands.registerCommand('ralphdex.endLoopAfterCurrent', () => endLoopAfterCurrent(output, status)));
  context.subscriptions.push(vscode.commands.registerCommand('ralphdex.stopLoop', () => stopLoop(output, status)));
}

function deactivate() {
  if (activeRun) {
    activeRun.cancel();
  }
}

async function startLoop(output, status) {
  return await runLoopCommand(output, status, false);
}

async function continueLoop(output, status) {
  return await runLoopCommand(output, status, true);
}

async function runLoopCommand(output, status, isContinuation) {
  if (activeRun) {
    vscode.window.showWarningMessage('Ralphdex is already running.');
    return;
  }

  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const config = vscode.workspace.getConfiguration('ralphdex');
  const loopOptions = await promptForLoopOptions(workspaceFolder.fsPath, config);
  if (!loopOptions) {
    return;
  }

  const { taskFilePath, maxIterations } = loopOptions;
  const progressFilePath = getProgressFilePath(taskFilePath);
  if (isContinuation) {
    const hasProgressFile = await fileExists(progressFilePath);
    if (!hasProgressFile) {
      vscode.window.showErrorMessage(`Cannot continue Ralph loop because no progress ledger exists at ${progressFilePath}.`);
      return;
    }
  } else {
    await ensureProgressFile(workspaceFolder.fsPath, taskFilePath, progressFilePath);
  }

  const stopWhenNoGapRemaining = config.get('stopWhenNoGapRemaining', true);
  const runner = createRunner(output, status);
  activeRun = runner;

  output.show(true);
  output.appendLine(`${isContinuation ? 'Continuing' : 'Starting'} Ralph loop in ${workspaceFolder.fsPath}`);
  output.appendLine(`Task file: ${taskFilePath}`);
  output.appendLine(`Progress file: ${progressFilePath}`);
  output.appendLine(`Max iterations: ${maxIterations}`);
  if (isContinuation) {
    output.appendLine('Last iteration output: loaded from progress ledger');
  }
  status.text = '$(sync~spin) Ralphdex running';

  try {
    let currentLastIterationOutput = isContinuation ? await fs.readFile(progressFilePath, 'utf8') : undefined;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      runner.throwIfCancelled();
      const result = await runIteration(workspaceFolder.fsPath, iteration, output, runner, taskFilePath, progressFilePath, currentLastIterationOutput);
      runner.throwIfCancelled();
      const iterationOutput = extractIterationSummary(result.output) || result.output;
      await appendProgressEntry(progressFilePath, iteration, result.exitCode, iterationOutput);

      if (result.exitCode !== 0) {
        vscode.window.showErrorMessage(`Ralphdex stopped after iteration ${iteration}; Codex exited with ${result.exitCode}.`);
        return;
      }

      currentLastIterationOutput = iterationOutput;

      if (runner.shouldStopAfterCurrent()) {
        output.appendLine('Ending Ralph loop after the completed iteration.');
        vscode.window.showInformationMessage(`Ralphdex ended after iteration ${iteration}.`);
        return;
      }

      if (stopWhenNoGapRemaining && hasNoGapRemaining(result.output)) {
        output.appendLine('Stopping because the iteration summary reports no highest-value gap remaining.');
        vscode.window.showInformationMessage(`Ralphdex completed after ${iteration} iteration(s).`);
        return;
      }
    }

    vscode.window.showInformationMessage(`Ralphdex reached the configured limit of ${maxIterations} iteration(s).`);
  } catch (error) {
    if (error && error.name === 'RalphdexCancelled') {
      output.appendLine('Ralphdex loop stopped by user.');
      vscode.window.showInformationMessage('Ralphdex loop stopped.');
      return;
    }

    output.appendLine(`Ralphdex failed: ${formatError(error)}`);
    vscode.window.showErrorMessage(`Ralphdex failed: ${formatError(error)}`);
  } finally {
    activeRun = undefined;
    status.text = '$(sync) Ralphdex';
  }
}

async function runSingleIteration(output, status) {
  if (activeRun) {
    vscode.window.showWarningMessage('Ralphdex is already running.');
    return;
  }

  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const config = vscode.workspace.getConfiguration('ralphdex');
  const taskFilePath = await promptForTaskFile(workspaceFolder.fsPath, config);
  if (!taskFilePath) {
    return;
  }
  const progressFilePath = getProgressFilePath(taskFilePath);
  await ensureProgressFile(workspaceFolder.fsPath, taskFilePath, progressFilePath);

  const runner = createRunner(output, status);
  activeRun = runner;
  output.show(true);
  output.appendLine(`Running one Ralph iteration in ${workspaceFolder.fsPath}`);
  output.appendLine(`Task file: ${taskFilePath}`);
  output.appendLine(`Progress file: ${progressFilePath}`);
  status.text = '$(sync~spin) Ralphdex running';

  try {
    const result = await runIteration(workspaceFolder.fsPath, 1, output, runner, taskFilePath, progressFilePath);
    runner.throwIfCancelled();
    await appendProgressEntry(progressFilePath, 1, result.exitCode, extractIterationSummary(result.output) || result.output);
    if (result.exitCode === 0) {
      vscode.window.showInformationMessage('Ralphdex iteration completed.');
    } else {
      vscode.window.showErrorMessage(`Ralphdex iteration failed; Codex exited with ${result.exitCode}.`);
    }
  } catch (error) {
    if (error && error.name === 'RalphdexCancelled') {
      output.appendLine('Ralphdex iteration stopped by user.');
      vscode.window.showInformationMessage('Ralphdex iteration stopped.');
      return;
    }

    output.appendLine(`Ralphdex failed: ${formatError(error)}`);
    vscode.window.showErrorMessage(`Ralphdex failed: ${formatError(error)}`);
  } finally {
    activeRun = undefined;
    status.text = '$(sync) Ralphdex';
  }
}

function stopLoop(output, status) {
  if (!activeRun) {
    vscode.window.showInformationMessage('Ralphdex is not running.');
    return;
  }

  activeRun.cancel();
  output.appendLine('Stopping Ralphdex after the current Codex process exits.');
  status.text = '$(debug-stop) Ralphdex stopping';
}

function endLoopAfterCurrent(output, status) {
  if (!activeRun) {
    vscode.window.showInformationMessage('Ralphdex is not running.');
    return;
  }

  activeRun.stopAfterCurrent();
  output.appendLine('Ralphdex will end after the current iteration completes.');
  status.text = '$(circle-slash) Ralphdex ending';
  vscode.window.showInformationMessage('Ralphdex will end after the current iteration completes.');
}

async function runIteration(workspaceFolder, iteration, output, runner, taskFilePath, progressFilePath, lastIterationOutput) {
  const config = vscode.workspace.getConfiguration('ralphdex');
  const promptPath = getBundledPromptPath();
  const prompt = await buildPrompt(promptPath, workspaceFolder, taskFilePath, progressFilePath, lastIterationOutput);
  const command = config.get('codexCommand', 'codex');
  const sendPromptToStdin = config.get('sendPromptToStdin', true);
  const args = config.get('codexArgs', ['exec', '--cd', '${workspaceFolder}', '-'])
    .map((arg) => arg
      .replaceAll('${workspaceFolder}', workspaceFolder)
      .replaceAll('${promptPath}', promptPath)
      .replaceAll('${prompt}', prompt));

  output.appendLine('');
  output.appendLine(`=== Ralph iteration ${iteration} ===`);
  output.appendLine(`Prompt: ${promptPath}`);
  output.appendLine(`Task: ${taskFilePath}`);
  output.appendLine(`Progress: ${progressFilePath}`);
  output.appendLine(`Command: ${command} ${args.map(quoteForLog).join(' ')}`);

  return await spawnCodex(command, args, workspaceFolder, output, runner, sendPromptToStdin ? prompt : undefined);
}

async function promptForLoopOptions(workspaceFolder, config) {
  const taskFilePath = await promptForTaskFile(workspaceFolder, config);
  if (!taskFilePath) {
    return undefined;
  }

  const maxIterations = await promptForIterationCount(config);
  if (!maxIterations) {
    return undefined;
  }

  return { taskFilePath, maxIterations };
}

async function promptForTaskFile(workspaceFolder, config) {
  const selected = await vscode.window.showOpenDialog({
    title: 'Select Ralph loop task file',
    defaultUri: vscode.Uri.file(workspaceFolder),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      'Task files': ['md', 'txt'],
      'All files': ['*']
    }
  });

  if (selected && selected[0]) {
    return selected[0].fsPath;
  }

  const fallback = config.get('taskPath', '');
  if (!fallback) {
    return undefined;
  }

  return path.resolve(workspaceFolder, fallback);
}

async function promptForIterationCount(config) {
  const configuredDefault = String(config.get('maxIterations', 5));
  const value = await vscode.window.showInputBox({
    title: 'Ralph loop iterations',
    prompt: 'How many fresh Codex iterations should Ralphdex run?',
    value: configuredDefault,
    validateInput(input) {
      const parsed = Number(input);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return 'Enter a whole number greater than zero.';
      }

      return undefined;
    }
  });

  if (value === undefined) {
    return undefined;
  }

  return Number(value);
}

async function buildPrompt(promptPath, workspaceFolder, taskFilePath, progressFilePath, lastIterationOutput) {
  const basePrompt = await fs.readFile(promptPath, 'utf8');
  const taskFile = toWorkspacePath(path.relative(workspaceFolder, taskFilePath));
  const progressFile = toWorkspacePath(path.relative(workspaceFolder, progressFilePath));
  const prompt = basePrompt
    .replaceAll('<taskfile>', taskFile)
    .replaceAll('<progressfile>', progressFile);

  if (!lastIterationOutput) {
    return prompt;
  }

  return `${prompt.trimEnd()}

## Last iteration output

${lastIterationOutput.trim()}
`;
}

async function ensureProgressFile(workspaceFolder, taskFilePath, progressFilePath) {
  try {
    await fs.access(progressFilePath);
    return;
  } catch {
    const taskFile = toWorkspacePath(path.relative(workspaceFolder, taskFilePath));
    const progressFile = toWorkspacePath(path.relative(workspaceFolder, progressFilePath));
    const initialContent = `# Ralph loop progress

Task file: \`${taskFile}\`
Progress file: \`${progressFile}\`
Created: ${new Date().toISOString()}

This file records Ralph loop continuity, iteration summaries, and known remaining work.
`;
    await fs.writeFile(progressFilePath, initialContent, 'utf8');
  }
}

async function appendProgressEntry(progressFilePath, iteration, exitCode, iterationOutput) {
  const status = exitCode === 0 ? 'completed' : `failed with exit code ${exitCode}`;
  const content = `

## Harness record - iteration ${iteration} - ${new Date().toISOString()}

Status: ${status}

\`\`\`md
${iterationOutput.trim()}
\`\`\`
`;
  await fs.appendFile(progressFilePath, content, 'utf8');
}

function spawnCodex(command, args, cwd, output, runner, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32'
    });

    runner.setChild(child);
    let combinedOutput = '';

    if (stdinText !== undefined && child.stdin) {
      child.stdin.end(stdinText);
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      output.append(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      combinedOutput += text;
      output.append(text);
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      runner.clearChild(child);
      output.appendLine('');
      output.appendLine(`Codex exited with ${exitCode}.`);
      resolve({ exitCode, output: combinedOutput });
    });
  });
}

function createRunner(output, status) {
  let cancelled = false;
  let stopAfterCurrent = false;
  let child = undefined;

  return {
    setChild(nextChild) {
      child = nextChild;
      if (cancelled) {
        killChild(child);
      }
    },
    clearChild(oldChild) {
      if (child === oldChild) {
        child = undefined;
      }
    },
    cancel() {
      cancelled = true;
      status.text = '$(debug-stop) Ralphdex stopping';
      if (child) {
        output.appendLine('Terminating active Codex process.');
        killChild(child);
      }
    },
    stopAfterCurrent() {
      stopAfterCurrent = true;
    },
    shouldStopAfterCurrent() {
      return stopAfterCurrent;
    },
    throwIfCancelled() {
      if (cancelled) {
        const error = new Error('Ralphdex cancelled');
        error.name = 'RalphdexCancelled';
        throw error;
      }
    }
  };
}

function killChild(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true });
    return;
  }

  child.kill('SIGTERM');
}

function getWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Open a workspace folder before running Ralphdex.');
    return undefined;
  }

  if (folders.length > 1) {
    vscode.window.showWarningMessage(`Ralphdex is using ${folders[0].name}. Multi-root selection is not implemented yet.`);
  }

  return folders[0].uri;
}

function hasNoGapRemaining(output) {
  const match = output.match(/Highest-value gap remaining for the next iteration:\s*(.+)/i);
  if (!match) {
    return false;
  }

  return /^(none|n\/a|nothing|no gap|no remaining gap)\.?$/i.test(match[1].trim());
}

function extractIterationSummary(output) {
  const marker = '## Iteration summary';
  const index = output.lastIndexOf(marker);
  if (index === -1) {
    return undefined;
  }

  return output.slice(index).trim();
}

function quoteForLog(value) {
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function toWorkspacePath(value) {
  return value.split(path.sep).join('/');
}

function getProgressFilePath(taskFilePath) {
  const taskDir = path.dirname(taskFilePath);
  const taskExt = path.extname(taskFilePath);
  const taskBase = path.basename(taskFilePath, taskExt);

  return path.join(taskDir, `${taskBase}.ralphdex-progress.md`);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getBundledPromptPath() {
  return path.join(extensionRoot || __dirname, 'plan-implement.md');
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }

  return error.message || String(error);
}

module.exports = {
  activate,
  deactivate
};

