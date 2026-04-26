const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

let activeRun = undefined;
let extensionRoot = undefined;
let controlViewProvider = undefined;
const uiState = {
  taskFilePath: '',
  progressFilePath: '',
  maxIterations: 5,
  status: 'Ready',
  isRunning: false,
  canEndAfterCurrent: false
};

function activate(context) {
  extensionRoot = context.extensionUri.fsPath;
  const output = vscode.window.createOutputChannel('Ralphdex');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'ralphdex.startLoop';
  status.text = '$(sync) Ralphdex';
  status.tooltip = 'Start Ralph loop';
  status.show();

  uiState.maxIterations = vscode.workspace.getConfiguration('ralphdex').get('maxIterations', 5);
  controlViewProvider = new RalphdexControlViewProvider(context.extensionUri, output, status);

  context.subscriptions.push(output, status);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('ralphdex.controlView', controlViewProvider));
  context.subscriptions.push(vscode.commands.registerCommand('ralphdex.openControl', () => vscode.commands.executeCommand('ralphdex.controlView.focus')));
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

class RalphdexControlViewProvider {
  constructor(extensionUri, output, status) {
    this.extensionUri = extensionUri;
    this.output = output;
    this.status = status;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = getControlViewHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.refresh();
  }

  refresh() {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: 'state',
      state: getSerializableUiState()
    });
  }

  async handleMessage(message) {
    if (!message || !message.type) {
      return;
    }

    if (message.type === 'ready') {
      this.refresh();
      return;
    }

    if (message.type === 'selectTask') {
      await selectTaskFileForUi();
      return;
    }

    if (message.type === 'openOutput') {
      this.output.show(true);
      return;
    }

    if (message.type === 'openProgress') {
      await openProgressFileFromUi();
      return;
    }

    if (message.type === 'stop') {
      stopLoop(this.output, this.status);
      return;
    }

    if (message.type === 'endAfterCurrent') {
      endLoopAfterCurrent(this.output, this.status);
      return;
    }

    if (message.type === 'runOnce') {
      const options = buildUiRunOptions(message);
      if (options) {
        await runSingleIteration(this.output, this.status, options);
      }
      return;
    }

    if (message.type === 'start' || message.type === 'continue') {
      const options = buildUiRunOptions(message);
      if (options) {
        await runLoopCommand(this.output, this.status, message.type === 'continue', options);
      }
    }
  }
}

function getControlViewHtml(webview) {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }
    .stack {
      display: grid;
      gap: 14px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      white-space: nowrap;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--vscode-charts-green);
      flex: 0 0 auto;
    }
    .dot.running {
      background: var(--vscode-progressBar-background);
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    input {
      box-sizing: border-box;
      width: 100%;
      min-height: 30px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 5px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-font-family);
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .task-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .file {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hint {
      min-height: 18px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .actions.single {
      grid-template-columns: 1fr;
    }
    button {
      min-height: 30px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 5px 8px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .divider {
      height: 1px;
      background: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
  </style>
</head>
<body>
  <main class="stack">
    <section class="header">
      <h2>Ralphdex</h2>
      <div class="status" title="Current Ralphdex status"><span id="dot" class="dot"></span><span id="status">Ready</span></div>
    </section>

    <section class="stack">
      <div class="task-row">
        <label>
          Task file
          <input id="taskFile" class="file" type="text" placeholder="Select a task file" readonly>
        </label>
        <button id="selectTask" class="secondary" type="button" title="Select task file">Browse</button>
      </div>
      <label>
        Iterations
        <input id="maxIterations" type="number" min="1" step="1">
      </label>
      <div id="progressFile" class="hint"></div>
    </section>

    <section class="actions">
      <button id="start" type="button">Start</button>
      <button id="continue" class="secondary" type="button">Continue</button>
    </section>
    <section class="actions">
      <button id="runOnce" class="secondary" type="button">Run Once</button>
      <button id="openProgress" class="secondary" type="button">Progress</button>
    </section>

    <div class="divider"></div>

    <section class="actions">
      <button id="endAfterCurrent" class="secondary" type="button">End After Current</button>
      <button id="stop" class="secondary" type="button">Stop</button>
    </section>
    <section class="actions single">
      <button id="openOutput" class="secondary" type="button">Show Output</button>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const els = {
      status: document.getElementById('status'),
      dot: document.getElementById('dot'),
      taskFile: document.getElementById('taskFile'),
      maxIterations: document.getElementById('maxIterations'),
      progressFile: document.getElementById('progressFile'),
      selectTask: document.getElementById('selectTask'),
      start: document.getElementById('start'),
      continueButton: document.getElementById('continue'),
      runOnce: document.getElementById('runOnce'),
      openProgress: document.getElementById('openProgress'),
      endAfterCurrent: document.getElementById('endAfterCurrent'),
      stop: document.getElementById('stop'),
      openOutput: document.getElementById('openOutput')
    };

    let currentState = {};

    function post(type) {
      vscode.postMessage({
        type,
        taskFilePath: els.taskFile.value,
        maxIterations: els.maxIterations.value
      });
    }

    function applyState(state) {
      currentState = state || {};
      els.status.textContent = currentState.status || 'Ready';
      els.dot.classList.toggle('running', !!currentState.isRunning);
      els.taskFile.value = currentState.taskFilePath || '';
      els.maxIterations.value = currentState.maxIterations || 5;
      els.progressFile.textContent = currentState.progressFilePath ? currentState.progressFilePath : '';

      const hasTask = !!currentState.taskFilePath;
      els.selectTask.disabled = !!currentState.isRunning;
      els.start.disabled = !hasTask || !!currentState.isRunning;
      els.continueButton.disabled = !hasTask || !!currentState.isRunning;
      els.runOnce.disabled = !hasTask || !!currentState.isRunning;
      els.openProgress.disabled = !currentState.progressFilePath;
      els.endAfterCurrent.disabled = !currentState.canEndAfterCurrent;
      els.stop.disabled = !currentState.isRunning;
    }

    els.selectTask.addEventListener('click', () => post('selectTask'));
    els.start.addEventListener('click', () => post('start'));
    els.continueButton.addEventListener('click', () => post('continue'));
    els.runOnce.addEventListener('click', () => post('runOnce'));
    els.openProgress.addEventListener('click', () => post('openProgress'));
    els.endAfterCurrent.addEventListener('click', () => post('endAfterCurrent'));
    els.stop.addEventListener('click', () => post('stop'));
    els.openOutput.addEventListener('click', () => post('openOutput'));
    els.maxIterations.addEventListener('change', () => {
      currentState.maxIterations = els.maxIterations.value;
    });

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'state') {
        applyState(event.data.state);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

async function startLoop(output, status) {
  return await runLoopCommand(output, status, false);
}

async function continueLoop(output, status) {
  return await runLoopCommand(output, status, true);
}

async function runLoopCommand(output, status, isContinuation, providedOptions) {
  if (activeRun) {
    vscode.window.showWarningMessage('Ralphdex is already running.');
    return;
  }

  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const config = vscode.workspace.getConfiguration('ralphdex');
  const loopOptions = providedOptions || await promptForLoopOptions(workspaceFolder.fsPath, config);
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
  setUiRunning(true, isContinuation ? 'Continuing loop...' : 'Running loop...', taskFilePath, progressFilePath, maxIterations);

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
      updateUiState({ status: `Running iteration ${iteration} of ${maxIterations}...` });
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
    setUiRunning(false, 'Ready', taskFilePath, progressFilePath, maxIterations);
  }
}

async function runSingleIteration(output, status, providedOptions) {
  if (activeRun) {
    vscode.window.showWarningMessage('Ralphdex is already running.');
    return;
  }

  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const config = vscode.workspace.getConfiguration('ralphdex');
  const taskFilePath = providedOptions && providedOptions.taskFilePath
    ? providedOptions.taskFilePath
    : await promptForTaskFile(workspaceFolder.fsPath, config);
  if (!taskFilePath) {
    return;
  }
  const progressFilePath = getProgressFilePath(taskFilePath);
  await ensureProgressFile(workspaceFolder.fsPath, taskFilePath, progressFilePath);

  const runner = createRunner(output, status);
  activeRun = runner;
  setUiRunning(true, 'Running one iteration...', taskFilePath, progressFilePath, uiState.maxIterations);
  output.show(true);
  output.appendLine(`Running one Ralph iteration in ${workspaceFolder.fsPath}`);
  output.appendLine(`Task file: ${taskFilePath}`);
  output.appendLine(`Progress file: ${progressFilePath}`);
  status.text = '$(sync~spin) Ralphdex running';

  try {
    updateUiState({ status: 'Running iteration 1 of 1...' });
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
    setUiRunning(false, 'Ready', taskFilePath, progressFilePath, uiState.maxIterations);
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
  updateUiState({ status: 'Stopping...', canEndAfterCurrent: false });
}

function endLoopAfterCurrent(output, status) {
  if (!activeRun) {
    vscode.window.showInformationMessage('Ralphdex is not running.');
    return;
  }

  activeRun.stopAfterCurrent();
  output.appendLine('Ralphdex will end after the current iteration completes.');
  status.text = '$(circle-slash) Ralphdex ending';
  updateUiState({ status: 'Ending after current iteration...', canEndAfterCurrent: false });
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

async function selectTaskFileForUi() {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  const selected = await vscode.window.showOpenDialog({
    title: 'Select Ralph loop task file',
    defaultUri: vscode.Uri.file(workspaceFolder.fsPath),
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      'Task files': ['md', 'txt'],
      'All files': ['*']
    }
  });

  if (!selected || !selected[0]) {
    return;
  }

  const taskFilePath = selected[0].fsPath;
  updateUiState({
    taskFilePath,
    progressFilePath: getProgressFilePath(taskFilePath),
    status: activeRun ? uiState.status : 'Ready'
  });
}

function buildUiRunOptions(message) {
  const taskFilePath = message && typeof message.taskFilePath === 'string'
    ? message.taskFilePath.trim()
    : '';
  if (!taskFilePath) {
    vscode.window.showWarningMessage('Select a Ralphdex task file first.');
    return undefined;
  }

  const maxIterations = Number(message.maxIterations);
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    vscode.window.showWarningMessage('Enter a whole number greater than zero for Ralphdex iterations.');
    return undefined;
  }

  updateUiState({
    taskFilePath,
    progressFilePath: getProgressFilePath(taskFilePath),
    maxIterations
  });
  return { taskFilePath, maxIterations };
}

async function openProgressFileFromUi() {
  if (!uiState.progressFilePath) {
    vscode.window.showInformationMessage('No Ralphdex progress file is selected yet.');
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(uiState.progressFilePath));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    vscode.window.showInformationMessage(`No Ralphdex progress file exists yet at ${uiState.progressFilePath}.`);
  }
}

function setUiRunning(isRunning, status, taskFilePath, progressFilePath, maxIterations) {
  updateUiState({
    isRunning,
    canEndAfterCurrent: isRunning,
    status,
    taskFilePath,
    progressFilePath,
    maxIterations
  });
}

function updateUiState(nextState) {
  Object.assign(uiState, nextState);
  if (controlViewProvider) {
    controlViewProvider.refresh();
  }
}

function getSerializableUiState() {
  return {
    taskFilePath: uiState.taskFilePath,
    progressFilePath: uiState.progressFilePath,
    maxIterations: uiState.maxIterations,
    status: uiState.status,
    isRunning: uiState.isRunning,
    canEndAfterCurrent: uiState.canEndAfterCurrent
  };
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

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

module.exports = {
  activate,
  deactivate
};

