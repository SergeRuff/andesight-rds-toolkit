const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const iceman = require("#src/iceman");
const mem_inspect = require("#src/mem_inspect")

let outputChannel;
let tailTimer;
let lastLogPath;
let extensionPath;
let templatesDir;
let lastScriptPathByWorkspace = new Map();
let tailState = {
    filePath: undefined,
    offset: 0,
    partial: ""
};

function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("GDB Script");
    }

    return outputChannel;
}

function getWorkspaceFolderForCommand(editor) {
    if (editor) {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

        if (folder) {
            return folder;
        }
    }

    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
}

function getWorkspaceKey(folder) {
    return folder ? folder.uri.toString() : "";
}

function getActiveWorkspaceFolder() {
    return getWorkspaceFolderForCommand(vscode.window.activeTextEditor);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeMiString(value) {
    return value
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
}

function cleanMiLine(line) {
    const match = line.match(/^[~&@]"(.*)"$/);
    if (!match) {
        return null;
    }

    return decodeMiString(match[1]);
}

function stopTail() {
    if (tailTimer) {
        clearInterval(tailTimer);
        tailTimer = undefined;
    }

    tailState = {
        filePath: undefined,
        offset: 0,
        partial: ""
    };
}

function readNewLogData(channel) {
    if (!tailState.filePath) {
        return;
    }

    let stat;

    try {
        stat = fs.statSync(tailState.filePath);
    } catch {
        return;
    }

    if (stat.size < tailState.offset) {
        tailState.offset = 0;
        tailState.partial = "";
    }

    if (stat.size === tailState.offset) {
        return;
    }

    const fd = fs.openSync(tailState.filePath, "r");

    try {
        const length = stat.size - tailState.offset;
        const buffer = Buffer.alloc(length);

        fs.readSync(fd, buffer, 0, length, tailState.offset);
        tailState.offset = stat.size;

        const text = tailState.partial + buffer.toString("utf8");
        const lines = text.split(/\r?\n/);

        tailState.partial = lines.pop() || "";

        for (const line of lines) {
            const cleaned = cleanMiLine(line);

            if (cleaned !== null && cleaned.length > 0) {
                channel.append(cleaned);
            }
        }
    } finally {
        fs.closeSync(fd);
    }
}

function startTail(logPath) {
    stopTail();

    lastLogPath = logPath;

    const channel = getOutputChannel();
    channel.clear();
    channel.show(true);

    tailState = {
        filePath: logPath,
        offset: 0,
        partial: ""
    };

    tailTimer = setInterval(() => readNewLogData(channel), 200);
}

async function ensureLaunchJson(context, folder) {
    const vscodeDir = path.join(folder.uri.fsPath, ".vscode");
    const launchPath = path.join(vscodeDir, "launch.json");

    if (fs.existsSync(launchPath)) {
        return;
    }

    const answer = await vscode.window.showWarningMessage(
        `No .vscode/launch.json found in "${folder.name}". Create a default launch.json for GDB Scripts?`,
        "Create",
        "Skip"
    );

    if (answer !== "Create") {
        return;
    }

    await writeDefaultLaunchJson(context, folder);
}

async function writeDefaultLaunchJson(context, folder) {
    const vscodeDir = path.join(folder.uri.fsPath, ".vscode");
    const launchPath = path.join(vscodeDir, "launch.json");
    const templatePath = path.join(templatesDir, "launch_default.json");

    let content;
    try {
        content = await fs.promises.readFile(templatePath, "utf8");
    } catch (error) {
        vscode.window.showErrorMessage(`Template not found: ${templatePath}`);
        return;
    }

    await fs.promises.mkdir(vscodeDir, { recursive: true });
    await fs.promises.writeFile(launchPath, content, "utf8");

    vscode.window.showInformationMessage("Created .vscode/launch.json for GDB Scripts Runner.");
}


function expandConfigValue(value, editor, folder) {
    if (typeof value === "string") {
        const filePath = editor ? editor.document.uri.fsPath : "";
        const folderPath = folder ? folder.uri.fsPath : "";
        const workspaceConfig = vscode.workspace.getConfiguration(undefined, folder && folder.uri);
        const expandString = (text) => text
            .replace(/\$\{file\}/g, filePath)
            .replace(/\$\{fileBasename\}/g, filePath ? path.basename(filePath) : "")
            .replace(/\$\{workspaceFolder\}/g, folderPath)
            .replace(/\$\{cwd\}/g, folderPath)
            .replace(/\$\{extensionPath\}/g, extensionPath || "");

        return expandString(value)
            .replace(/\$\{config:([^}]+)\}/g, (_, key) => {
                const configValue = workspaceConfig.get(key);
                return configValue === undefined ? "" : expandString(String(configValue));
            });
    }

    if (Array.isArray(value)) {
        return value.map((item) => expandConfigValue(item, editor, folder));
    }

    if (value && typeof value === "object") {
        const result = {};

        for (const [key, nestedValue] of Object.entries(value)) {
            result[key] = expandConfigValue(nestedValue, editor, folder);
        }

        return result;
    }

    return value;
}

function getDebugConfiguration(folder, editor) {
    const launch = vscode.workspace.getConfiguration("launch", folder.uri);
    const configurations = launch.get("configurations", []);

    const selectedName = vscode.workspace.getConfiguration("debug").get("selectedConfiguration");
    const baseConfig =
        configurations.find((config) => config.name === selectedName) ||
        configurations.find((config) => config.name === "CDT GDB Target: run script file") ||
        configurations.find((config) => config.name === "GDB-Multiarch: run script file") ||
        configurations[0];

    if (!baseConfig) {
        return undefined;
    }

    return expandConfigValue(baseConfig, editor, folder);
}

function setLastScriptPath(folder, scriptPath) {
    lastScriptPathByWorkspace.set(getWorkspaceKey(folder), scriptPath);
}

function getLastScriptPath(folder) {
    return lastScriptPathByWorkspace.get(getWorkspaceKey(folder));
}

function isScriptRunnerDebugConfiguration(config) {
    return config.name === "CDT GDB Target: run script file" ||
        config.name === "GDB-Multiarch: run script file";
}

function getConfigScriptPath(folder, config) {
    if (config.__gdbScriptRunnerScriptPath) {
        return config.__gdbScriptRunnerScriptPath;
    }

    if (isScriptRunnerDebugConfiguration(config)) {
        return getLastScriptPath(folder);
    }

    return undefined;
}

function applyScriptPathToInitCommands(config, scriptPath) {
    if (!scriptPath || !Array.isArray(config.initCommands)) {
        return config;
    }

    return {
        ...config,
        initCommands: config.initCommands.map((command) => {
            if (typeof command !== "string") {
                return command;
            }

            if (command.includes("${file}")) {
                return command.replace(/\$\{file\}/g, scriptPath);
            }

            if (/^\s*source\s+/.test(command)) {
                return `source ${scriptPath}`;
            }

            return command;
        })
    };
}

function expandExtensionPathValue(value) {
    if (typeof value === "string") {
        return value.replace(/\$\{extensionPath\}/g, extensionPath || "");
    }

    if (Array.isArray(value)) {
        return value.map(expandExtensionPathValue);
    }

    if (value && typeof value === "object") {
        const result = {};

        for (const [key, nestedValue] of Object.entries(value)) {
            result[key] = expandExtensionPathValue(nestedValue);
        }

        return result;
    }

    return value;
}

function createDebugConfigurationProvider() {
    return {
        resolveDebugConfiguration(folder, config) {
            const scriptPath = getConfigScriptPath(folder, config);
            return applyScriptPathToInitCommands(config, scriptPath);
        },
        resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
            const scriptPath = getConfigScriptPath(folder, config);
            return expandExtensionPathValue(applyScriptPathToInitCommands(config, scriptPath));
        }
    };
}

async function activate(context) {
    extensionPath = context.extensionPath;
    templatesDir = path.join(context.extensionPath, "templates");
    iceman.activate(context, { getWorkspaceFolderForCommand });

    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            await ensureLaunchJson(context, folder);
        }
    }

    const regenerateLaunchDisposable = vscode.commands.registerCommand("gdbScript.regenerateLaunchJson", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);

        if (!folder) {
            vscode.window.showErrorMessage("Open a workspace folder before regenerating launch.json.");
            return;
        }

        const launchPath = path.join(folder.uri.fsPath, ".vscode", "launch.json");

        if (fs.existsSync(launchPath)) {
            const answer = await vscode.window.showWarningMessage(
                `Replace existing .vscode/launch.json in "${folder.name}" with the default template?`,
                "Replace",
                "Cancel"
            );

            if (answer !== "Replace") {
                return;
            }
        }

        await writeDefaultLaunchJson(context, folder);
    });

    const openDisassemblyRightDisposable = vscode.commands.registerCommand("gdbScript.openDisassemblyViewRight", async () => {
        await vscode.commands.executeCommand("debug.action.openDisassemblyView");
        await vscode.commands.executeCommand("workbench.action.moveEditorToNextGroup");
    });

    const showMemoryInspectorDisposable = vscode.commands.registerCommand("gdbScript.showMemoryInspector", async () => {
        await vscode.commands.executeCommand("memory-inspector.show");
    });

    const disposable = vscode.commands.registerCommand("gdbScript.runCurrent", async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor || !editor.document.fileName.endsWith(".gdb")) {
            vscode.window.showWarningMessage("Open a .gdb script first.");
            return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const scriptPath = editor.document.uri.fsPath;

        if (!folder) {
            vscode.window.showErrorMessage("The .gdb file is not inside an opened workspace folder.");
            return;
        }

        setLastScriptPath(folder, scriptPath);

        const logPath = path.join(folder.uri.fsPath, "gdb-session.log");
        startTail(logPath);

        const icemanConfig = iceman.getIcemanConfiguration(folder, editor);
        if (icemanConfig.enabled) {
            const started = await iceman.startIceman(folder, editor);

            if (!started) {
                return;
            }
        }

        const config = getDebugConfiguration(folder, editor);

        if (!config) {
            vscode.window.showErrorMessage("No debug configuration found in launch.json.");
            return;
        }

        config.__gdbScriptRunnerScriptPath = scriptPath;

        await vscode.debug.startDebugging(folder, config);

    });

    const startDisposable = vscode.debug.onDidStartDebugSession(() => {
        if (!tailTimer && lastLogPath) {
            startTail(lastLogPath);
        }
    });

    const terminateDisposable = vscode.debug.onDidTerminateDebugSession(() => {
        const channel = getOutputChannel();
        readNewLogData(channel);
        stopTail();
    });

    const gdbTargetDebugConfigurationProviderDisposable = vscode.debug.registerDebugConfigurationProvider(
        "gdbtarget",
        createDebugConfigurationProvider()
    );
    const gdbDebugConfigurationProviderDisposable = vscode.debug.registerDebugConfigurationProvider(
        "gdb",
        createDebugConfigurationProvider()
    );

    const showSelectedVariableInMemoryInspectorDisposable =
    vscode.commands.registerCommand("gdbScript.showSelectedVariableInMemoryInspector", async () => {
        const editor = vscode.window.activeTextEditor;
        const session = vscode.debug.activeDebugSession;

        if (!editor || !session) {
            vscode.window.showWarningMessage("No active debug session.");
            return;
        }

        const document = editor.document;
        let expression = document.getText(editor.selection).trim();

        if (!expression) {
            const wordRange = document.getWordRangeAtPosition(
                editor.selection.active,
                /[A-Za-z_]\w*(?:->\w+|\.\w+|\[[^\]]+\])*/
            );

            if (wordRange) {
                expression = document.getText(wordRange).trim();
            }
        }

        if (!expression) {
            vscode.window.showWarningMessage("No variable selected.");
            return;
        }

        await vscode.commands.executeCommand("memory-inspector.show-variable", {
            sessionId: session.id,
            variable: {
                name: expression,
                value: ""
            },
            container: {
                expression
            }
        });
    });

    const showSelectedPointerTargetInMemoryInspectorDisposable =
    vscode.commands.registerCommand("gdbScript.showSelectedPointerTargetInMemoryInspector", async () => {
        const editor = vscode.window.activeTextEditor;
        const session = vscode.debug.activeDebugSession;

        if (!editor || !session) {
            vscode.window.showWarningMessage("No active debug session.");
            return;
        }

        const document = editor.document;
        let expression = document.getText(editor.selection).trim();

        if (!expression) {
            const wordRange = document.getWordRangeAtPosition(
                editor.selection.active,
                /[A-Za-z_]\w*(?:->\w+|\.\w+|\[[^\]]+\])*/
            );

            if (wordRange) {
                expression = document.getText(wordRange).trim();
            }
        }

        if (!expression) {
            vscode.window.showWarningMessage("No variable selected.");
            return;
        }

        const pointerTargetExpression = `*(${expression})`;
        await vscode.commands.executeCommand("memory-inspector.show-variable", {
            sessionId: session.id,
            variable: {
                name: pointerTargetExpression,
                value: ""
            },
            container: {
                expression: pointerTargetExpression
            }
        });
    });


    context.subscriptions.push(
        disposable,
        regenerateLaunchDisposable,
        openDisassemblyRightDisposable,
        showMemoryInspectorDisposable,
        startDisposable,
        terminateDisposable,
        gdbTargetDebugConfigurationProviderDisposable,
        gdbDebugConfigurationProviderDisposable,
        showSelectedVariableInMemoryInspectorDisposable,
        showSelectedPointerTargetInMemoryInspectorDisposable,
        {
            dispose: () => {
                stopTail();
                iceman.deactivate();
            }
        }
    );
}

function deactivate() {
    stopTail();
    iceman.deactivate();

    if (outputChannel) {
        outputChannel.dispose();
        outputChannel = undefined;
    }
}

module.exports = {
    activate,
    deactivate
};
