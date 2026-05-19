const path = require("path");
const vscode = require("vscode");
const logger = require("#src/logger");

let extensionPath;
let lastScriptPathByWorkspace = new Map();
let ensureIcemanStartedForDebug = async () => true;

function getWorkspaceKey(folder) {
    return folder ? folder.uri.toString() : "";
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

function registerRunCurrentCommand() {
    return vscode.commands.registerCommand("gdbScript.runCurrent", async () => {
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
        logger.startTail(logPath);

        const icemanStarted = await ensureIcemanStartedForDebug(folder, editor);
        if (!icemanStarted) {
            return;
        }

        const config = getDebugConfiguration(folder, editor);

        if (!config) {
            vscode.window.showErrorMessage("No debug configuration found in launch.json.");
            return;
        }

        config.__gdbScriptRunnerScriptPath = scriptPath;

        await vscode.debug.startDebugging(folder, config);
    });
}

function activate(context, options = {}) {
    extensionPath = context.extensionPath;
    ensureIcemanStartedForDebug = options.ensureIcemanStartedForDebug || ensureIcemanStartedForDebug;

    const startDisposable = vscode.debug.onDidStartDebugSession(() => {
        logger.resumeTail();
    });

    const terminateDisposable = vscode.debug.onDidTerminateDebugSession(() => {
        logger.readNewLogData();
        logger.stopTail();
    });

    const gdbTargetDebugConfigurationProviderDisposable = vscode.debug.registerDebugConfigurationProvider(
        "gdbtarget",
        createDebugConfigurationProvider()
    );
    const gdbDebugConfigurationProviderDisposable = vscode.debug.registerDebugConfigurationProvider(
        "gdb",
        createDebugConfigurationProvider()
    );

    context.subscriptions.push(
        registerRunCurrentCommand(),
        startDisposable,
        terminateDisposable,
        gdbTargetDebugConfigurationProviderDisposable,
        gdbDebugConfigurationProviderDisposable,
        {
            dispose: deactivate
        }
    );
}

function deactivate() {
    logger.deactivate();
}

module.exports = {
    activate,
    deactivate
};
