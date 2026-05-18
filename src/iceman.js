const fs = require("fs");
const net = require("net");
const path = require("path");
const vscode = require("vscode");

const ANDES_ICEMAN_DEFAULTS = {
    burnerPort: 9900,
    telnetPort: 9901,
    gdbPortRange: "9902:49151",
    targetType: "v5",
    startupDelayMs: 3000
};
const GDB_SCRIPT_RUNNER_DEFAULTS = {
    targetPort: 9902
};
const ICEMAN_COOLDOWN_MS = 300;

let extensionPath;
let icemanTerminal;
let icemanStatusItem;
let icemanTargetItem;
let statusTimer;
let getWorkspaceFolderForCommand = defaultGetWorkspaceFolderForCommand;

function activate(context, options = {}) {
    extensionPath = context.extensionPath;
    getWorkspaceFolderForCommand = options.getWorkspaceFolderForCommand || defaultGetWorkspaceFolderForCommand;

    icemanStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    icemanTargetItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    icemanStatusItem.name = "Andes ICEman Status";
    icemanTargetItem.name = "Andes ICEman Target";
    icemanStatusItem.show();

    updateIcemanStatusBar();
    statusTimer = setInterval(updateIcemanStatusBar, 2000);

    context.subscriptions.push(
        registerStartIcemanCommand(),
        registerStopIcemanCommand(),
        registerRestartIcemanCommand(),
        registerSelectIcemanTargetTypeCommand(),
        registerSetIcemanBurnerPortCommand(),
        registerSetIcemanTelnetPortCommand(),
        registerSetIcemanGdbPortRangeCommand(),
        registerSetTargetPortCommand(),
        registerShowIcemanConfigActionsCommand(),
        vscode.window.onDidCloseTerminal(handleClosedTerminal),
        vscode.window.onDidChangeActiveTextEditor(updateIcemanStatusBar),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("gdbScriptRunner.target") || event.affectsConfiguration("andesIceman")) {
                updateIcemanStatusBar();
            }
        }),
        icemanStatusItem,
        icemanTargetItem,
        {
            dispose: deactivate
        }
    );
}

function deactivate() {
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = undefined;
    }

    stopIceman(false);

    if (icemanStatusItem) {
        icemanStatusItem.dispose();
        icemanStatusItem = undefined;
    }

    if (icemanTargetItem) {
        icemanTargetItem.dispose();
        icemanTargetItem = undefined;
    }
}

function defaultGetWorkspaceFolderForCommand(editor) {
    if (editor) {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

        if (folder) {
            return folder;
        }
    }

    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
}

function getActiveWorkspaceFolder() {
    return getWorkspaceFolderForCommand(vscode.window.activeTextEditor);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

function getIcemanConfiguration(folder, editor) {
    const config = vscode.workspace.getConfiguration("andesIceman", folder && folder.uri);

    return {
        enabled: config.get("enabled", false),
        executable: expandConfigValue(config.get("executable", "iceman"), editor, folder),
        args: expandConfigValue(config.get("args", []), editor, folder),
        cwd: expandConfigValue(config.get("cwd", "${workspaceFolder}"), editor, folder),
        andesRoot: expandConfigValue(config.get("andesRoot", ""), editor, folder),
        burnerPort: config.get("burnerPort", ANDES_ICEMAN_DEFAULTS.burnerPort),
        telnetPort: config.get("telnetPort", ANDES_ICEMAN_DEFAULTS.telnetPort),
        gdbPortRange: expandConfigValue(config.get("gdbPortRange", ANDES_ICEMAN_DEFAULTS.gdbPortRange), editor, folder),
        targetType: config.get("targetType", ANDES_ICEMAN_DEFAULTS.targetType),
        useAndesEnvironment: config.get("useAndesEnvironment", false),
        startupDelayMs: config.get("startupDelayMs", ANDES_ICEMAN_DEFAULTS.startupDelayMs)
    };
}

async function promptAndUpdateNumericSetting(config, key, options, target) {
    const currentValue = config.get(key, options.defaultValue);
    const input = await vscode.window.showInputBox({
        title: options.title,
        prompt: `Current: ${currentValue}. Default: ${options.defaultValue}.`,
        placeHolder: String(options.defaultValue),
        value: String(currentValue),
        validateInput: (value) => {
            const trimmedValue = value.trim();

            if (!trimmedValue) {
                return undefined;
            }

            const numericValue = Number(trimmedValue);

            if (!/^\d+$/.test(trimmedValue)) {
                return options.integerErrorMessage;
            }

            if (!Number.isInteger(numericValue) || numericValue < options.minimum || numericValue > options.maximum) {
                return options.rangeErrorMessage;
            }

            return undefined;
        }
    });

    if (input === undefined) {
        return undefined;
    }

    const updatedValue = input.trim() ? Number(input.trim()) : options.defaultValue;
    await config.update(key, updatedValue, target);

    return updatedValue;
}

async function promptAndUpdateStringSetting(config, key, options, target) {
    const currentValue = config.get(key, options.defaultValue);
    const input = await vscode.window.showInputBox({
        title: options.title,
        prompt: `Current: ${currentValue}. Default: ${options.defaultValue}.`,
        placeHolder: String(options.defaultValue),
        value: String(currentValue),
        validateInput: (value) => {
            const trimmedValue = value.trim();

            if (!trimmedValue) {
                return undefined;
            }

            return options.validate(trimmedValue);
        }
    });

    if (input === undefined) {
        return undefined;
    }

    const updatedValue = input.trim() || options.defaultValue;
    await config.update(key, updatedValue, target);

    return updatedValue;
}

function validateTcpPort(value) {
    const port = Number(value);

    return /^\d+$/.test(value) && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validateGdbPortRange(value) {
    const parts = value.split(":");

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return "Enter a GDB port range in format startPort:endPort.";
    }

    if (!validateTcpPort(parts[0]) || !validateTcpPort(parts[1])) {
        return "Both ports must be numeric TCP ports in range 1..65535.";
    }

    if (Number(parts[0]) > Number(parts[1])) {
        return "Start port must be less than or equal to end port.";
    }

    return undefined;
}

function trimTrailingSeparators(value) {
    return value.replace(/[\\/]+$/, "");
}

function ensureTrailingSeparator(value) {
    return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function getPathEnvKey(env) {
    return Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
}

function getAndesPaths(icemanConfig) {
    const andesRoot = trimTrailingSeparators(icemanConfig.andesRoot || "");

    if (!andesRoot) {
        return undefined;
    }

    const home = path.join(andesRoot, "ice");
    const cygwinBin = path.join(andesRoot, "cygwin", "bin");

    return {
        andesRoot,
        home,
        homeForEnv: ensureTrailingSeparator(home),
        cygwinBin,
        bashPath: path.join(cygwinBin, "bash.exe")
    };
}

function buildIcemanEnvironment(icemanConfig, andesPaths) {
    const env = { ...process.env };

    if (!icemanConfig.useAndesEnvironment) {
        return env;
    }

    if (!andesPaths) {
        return env;
    }

    const pathKey = getPathEnvKey(env);

    env.HOME = andesPaths.homeForEnv;
    env[pathKey] = `${andesPaths.cygwinBin};${andesPaths.homeForEnv};${env[pathKey] || ""}`;
    env.CYGPATH = "cygpath";

    if (fs.existsSync(andesPaths.bashPath)) {
        env.SHELL = "/bin/bash";
    }

    return env;
}

function quoteCmdArg(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteBashString(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildCmdCommand(executable, args) {
    return [quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(" ");
}

function buildBashIcemanCommand(executable, args) {
    const executableCommand = `"$(cygpath -u ${quoteBashString(executable)})"`;
    const quotedArgs = args.map(quoteBashString);

    return [executableCommand, ...quotedArgs].join(" ");
}

function normalizeIcemanArgs(args) {
    if (Array.isArray(args)) {
        return args.map((arg) => String(arg));
    }

    if (typeof args === "string" && args.trim().length > 0) {
        return args.trim().split(/\s+/);
    }

    return [];
}

function buildIcemanArgs(icemanConfig) {
    return [
        `--bport=${icemanConfig.burnerPort}`,
        `--tport=${icemanConfig.telnetPort}`,
        `--port=${icemanConfig.gdbPortRange}`,
        "-Z",
        icemanConfig.targetType,
        ...normalizeIcemanArgs(icemanConfig.args)
    ];
}

function getTargetEndpoint(folder) {
    const config = vscode.workspace.getConfiguration("gdbScriptRunner.target", folder && folder.uri);

    return {
        host: config.get("host", "localhost"),
        port: Number(config.get("port", GDB_SCRIPT_RUNNER_DEFAULTS.targetPort))
    };
}

function getTcpHostCandidates(host) {
    const normalizedHost = String(host || "localhost").trim();

    if (normalizedHost.toLowerCase() === "localhost") {
        return ["127.0.0.1", "::1", "localhost"];
    }

    return [normalizedHost];
}

function isTcpPortOpen(host, port, timeoutMs = 500) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (isOpen) => {
            if (settled) {
                return;
            }

            settled = true;
            socket.destroy();
            resolve(isOpen);
        };

        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        socket.connect(port, host);
    });
}

async function waitForTcpPortOpen(host, port, timeoutMs, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    const hostCandidates = getTcpHostCandidates(host);

    while (Date.now() <= deadline) {
        for (const candidateHost of hostCandidates) {
            if (await isTcpPortOpen(candidateHost, port)) {
                return true;
            }
        }

        await delay(intervalMs);
    }

    return false;
}

async function isTargetEndpointAvailable(folder) {
    const targetEndpoint = getTargetEndpoint(folder);

    if (!Number.isInteger(targetEndpoint.port) || targetEndpoint.port <= 0 || targetEndpoint.port > 65535) {
        return false;
    }

    return waitForTcpPortOpen(targetEndpoint.host, targetEndpoint.port, 500, 0);
}

async function updateIcemanStatusBar() {
    if (!icemanStatusItem || !icemanTargetItem) {
        return;
    }

    const folder = getActiveWorkspaceFolder();

    const targetEndpoint = getTargetEndpoint(folder);
    const targetText = `${targetEndpoint.host}:${targetEndpoint.port}`;
    const isAvailable = await isTargetEndpointAvailable(folder);

    icemanStatusItem.text = isAvailable
        ? "$(remote-explorer-view-icon) ICEman is working:"
        : "$(debug-disconnect) ICEman is inactive";
    icemanStatusItem.color = new vscode.ThemeColor(isAvailable ? "testing.iconPassed" : "errorForeground");
    icemanStatusItem.tooltip = isAvailable
        ? `Andes ICEman target is available at ${targetText}.`
        : `Andes ICEman target is not available at ${targetText}.`;
    icemanStatusItem.command = isAvailable ? "gdbScript.stopIceman" : "gdbScript.restartIceman";

    if (isAvailable) {
        icemanTargetItem.text = targetText;
        icemanTargetItem.color = undefined;
        icemanTargetItem.tooltip = `Configured GDB target endpoint: ${targetText}.`;
        icemanTargetItem.command = {
            command: "gdbScript.showIcemanConfigActions",
            title: "Configure Andes ICEman"
        };
        icemanTargetItem.show();
    } else {
        icemanTargetItem.text = "$(settings-gear) Config";
        icemanTargetItem.color = new vscode.ThemeColor("disabledForeground");
        icemanTargetItem.tooltip = `Andes ICEman target is not available at ${targetText}.`;
        icemanTargetItem.command = {
            command: "gdbScript.showIcemanConfigActions",
            title: "Configure Andes ICEman"
        };
        icemanTargetItem.show();
    }
}

async function startIceman(folder, editor, showAlreadyRunningMessage = false) {
    const targetEndpoint = getTargetEndpoint(folder);

    if (!Number.isInteger(targetEndpoint.port) || targetEndpoint.port <= 0 || targetEndpoint.port > 65535) {
        vscode.window.showErrorMessage(`Invalid GDB target port: ${targetEndpoint.port}.`);
        return false;
    }

    if (icemanTerminal) {
        if (!(await waitForTcpPortOpen(targetEndpoint.host, targetEndpoint.port, 500, 0))) {
            vscode.window.showErrorMessage(
                `Andes ICEman terminal is open, but GDB target ${targetEndpoint.host}:${targetEndpoint.port} is not available. Check the Andes ICEman terminal for errors or restart ICEman.`
            );
            return false;
        }

        if (showAlreadyRunningMessage) {
            vscode.window.showInformationMessage("Andes ICEman is already running.");
        }

        return true;
    }

    const icemanConfig = getIcemanConfiguration(folder, editor);
    const executable = icemanConfig.executable && String(icemanConfig.executable).trim();

    if (await waitForTcpPortOpen(targetEndpoint.host, targetEndpoint.port, 500, 0)) {
        vscode.window.showWarningMessage(
            `GDB target ${targetEndpoint.host}:${targetEndpoint.port} is already in use. Skipping Andes ICEman start.`
        );
        return true;
    }

    if (!executable) {
        vscode.window.showErrorMessage("Andes ICEman executable path is empty.");
        return false;
    }

    const args = buildIcemanArgs(icemanConfig);
    const cwd = icemanConfig.cwd || (folder && folder.uri.fsPath);
    const andesPaths = getAndesPaths(icemanConfig);
    const env = buildIcemanEnvironment(icemanConfig, andesPaths);

    if (icemanConfig.useAndesEnvironment && (!andesPaths || !fs.existsSync(andesPaths.bashPath))) {
        vscode.window.showErrorMessage("Andes Cygwin bash.exe was not found. Check andesIceman.andesRoot.");
        return false;
    }

    const terminalOptions = {
        name: "Andes ICEman",
        cwd,
        env
    };

    let command;

    if (icemanConfig.useAndesEnvironment) {
        terminalOptions.shellPath = andesPaths.bashPath;
        terminalOptions.shellArgs = ["--login", "-i"];
        command = buildBashIcemanCommand(executable, args);
    } else {
        terminalOptions.shellPath = process.env.ComSpec || "cmd.exe";
        command = buildCmdCommand(executable, args);
    }

    icemanTerminal = vscode.window.createTerminal(terminalOptions);
    icemanTerminal.show(true);
    icemanTerminal.sendText(command, true);

    const startupTimeoutMs = Math.max(icemanConfig.startupDelayMs, 1000);
    const started = await waitForTcpPortOpen(targetEndpoint.host, targetEndpoint.port, startupTimeoutMs);

    if (!started) {
        vscode.window.showErrorMessage(
            `Andes ICEman did not start correctly. GDB target ${targetEndpoint.host}:${targetEndpoint.port} is not available. Check the Andes ICEman terminal for errors.`
        );
        return false;
    }

    return true;
}

function stopIceman(showMessage = true) {
    if (!icemanTerminal) {
        if (showMessage) {
            vscode.window.showInformationMessage("Andes ICEman is not running.");
        }

        return;
    }

    const terminalToStop = icemanTerminal;
    icemanTerminal = undefined;
    terminalToStop.dispose();

    if (showMessage) {
        vscode.window.showInformationMessage("Stopped Andes ICEman.");
    }
}

function handleClosedTerminal(terminal) {
    if (terminal !== icemanTerminal) {
        return false;
    }

    icemanTerminal = undefined;
    updateIcemanStatusBar();
    return true;
}

function registerStartIcemanCommand() {
    return vscode.commands.registerCommand("gdbScript.startIceman", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);

        if (!folder) {
            vscode.window.showErrorMessage("Open a workspace folder before starting Andes ICEman.");
            return;
        }

        await startIceman(folder, editor, true);
        await updateIcemanStatusBar();
    });
}

function registerStopIcemanCommand() {
    return vscode.commands.registerCommand("gdbScript.stopIceman", () => {
        stopIceman(true);
        updateIcemanStatusBar();
    });
}

function registerRestartIcemanCommand() {
    return vscode.commands.registerCommand("gdbScript.restartIceman", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);

        if (!folder) {
            vscode.window.showErrorMessage("Open a workspace folder before restarting Andes ICEman.");
            return;
        }

        stopIceman(false);
        await delay(ICEMAN_COOLDOWN_MS);
        await startIceman(folder, editor, false);
        await updateIcemanStatusBar();
    });
}

function registerSelectIcemanTargetTypeCommand() {
    return vscode.commands.registerCommand("gdbScript.selectIcemanTargetType", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);
        const config = vscode.workspace.getConfiguration("andesIceman", folder && folder.uri);
        const currentTargetType = config.get("targetType", ANDES_ICEMAN_DEFAULTS.targetType);
        const defaultTargetType = ANDES_ICEMAN_DEFAULTS.targetType;
        const targetTypes = ["v2", "v3", "v3m", "v5"];
        const selected = await vscode.window.showQuickPick(
            targetTypes.map((targetType) => {
                const descriptions = [];

                if (targetType === currentTargetType) {
                    descriptions.push("current");
                }

                if (targetType === defaultTargetType) {
                    descriptions.push("default");
                }

                return {
                    label: targetType,
                    description: descriptions.join(", ") || undefined
                };
            }),
            {
                placeHolder: "Select Andes ICEman target type"
            }
        );

        if (!selected) {
            return;
        }

        await config.update(
            "targetType",
            selected.label,
            folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(`Andes ICEman target type set to ${selected.label}.`);
    });
}

function registerSetIcemanBurnerPortCommand() {
    return vscode.commands.registerCommand("gdbScript.setIcemanBurnerPort", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);
        const config = vscode.workspace.getConfiguration("andesIceman", folder && folder.uri);
        const burnerPort = await promptAndUpdateNumericSetting(
            config,
            "burnerPort",
            {
                defaultValue: ANDES_ICEMAN_DEFAULTS.burnerPort,
                minimum: 1,
                maximum: 65535,
                title: "Set Andes ICEman burner port",
                integerErrorMessage: "Enter a numeric TCP port.",
                rangeErrorMessage: "Port must be in range 1..65535."
            },
            folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );

        if (burnerPort === undefined) {
            return;
        }

        vscode.window.showInformationMessage(`Andes ICEman burner port set to ${burnerPort}.`);
    });
}

function registerSetIcemanTelnetPortCommand() {
    return vscode.commands.registerCommand("gdbScript.setIcemanTelnetPort", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);
        const config = vscode.workspace.getConfiguration("andesIceman", folder && folder.uri);
        const telnetPort = await promptAndUpdateNumericSetting(
            config,
            "telnetPort",
            {
                defaultValue: ANDES_ICEMAN_DEFAULTS.telnetPort,
                minimum: 1,
                maximum: 65535,
                title: "Set Andes ICEman telnet port",
                integerErrorMessage: "Enter a numeric TCP port.",
                rangeErrorMessage: "Port must be in range 1..65535."
            },
            folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );

        if (telnetPort === undefined) {
            return;
        }

        vscode.window.showInformationMessage(`Andes ICEman telnet port set to ${telnetPort}.`);
    });
}

function registerSetIcemanGdbPortRangeCommand() {
    return vscode.commands.registerCommand("gdbScript.setIcemanGdbPortRange", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);
        const config = vscode.workspace.getConfiguration("andesIceman", folder && folder.uri);
        const gdbPortRange = await promptAndUpdateStringSetting(
            config,
            "gdbPortRange",
            {
                defaultValue: ANDES_ICEMAN_DEFAULTS.gdbPortRange,
                title: "Set Andes ICEman GDB port range",
                validate: validateGdbPortRange
            },
            folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );

        if (gdbPortRange === undefined) {
            return;
        }

        vscode.window.showInformationMessage(`Andes ICEman GDB port range set to ${gdbPortRange}.`);
    });
}

function registerSetTargetPortCommand() {
    return vscode.commands.registerCommand("gdbScript.setTargetPort", async () => {
        const editor = vscode.window.activeTextEditor;
        const folder = getWorkspaceFolderForCommand(editor);
        const config = vscode.workspace.getConfiguration("gdbScriptRunner.target", folder && folder.uri);
        const targetPort = await promptAndUpdateNumericSetting(
            config,
            "port",
            {
                defaultValue: GDB_SCRIPT_RUNNER_DEFAULTS.targetPort,
                minimum: 1,
                maximum: 65535,
                title: "Set GDB target port",
                integerErrorMessage: "Enter a numeric TCP port.",
                rangeErrorMessage: "Port must be a numeric TCP port in range 1..65535."
            },
            folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );

        if (targetPort === undefined) {
            return;
        }

        await updateIcemanStatusBar();
        vscode.window.showInformationMessage(`GDB target port set to ${targetPort}.`);
    });
}

function registerShowIcemanConfigActionsCommand() {
    return vscode.commands.registerCommand("gdbScript.showIcemanConfigActions", async () => {
        while (true) {
            const editor = vscode.window.activeTextEditor;
            const folder = getWorkspaceFolderForCommand(editor);
            const icemanConfig = vscode.workspace.getConfiguration("andesIceman", folder && folder.uri);
            const targetConfig = vscode.workspace.getConfiguration("gdbScriptRunner.target", folder && folder.uri);
            const selected = await vscode.window.showQuickPick(
                [
                    {
                        label: "Select Andes ICEman Target Type",
                        description: String(icemanConfig.get("targetType", ANDES_ICEMAN_DEFAULTS.targetType)),
                        command: "gdbScript.selectIcemanTargetType"
                    },
                    {
                        label: "Set Andes ICEman Burner Port",
                        description: String(icemanConfig.get("burnerPort", ANDES_ICEMAN_DEFAULTS.burnerPort)),
                        command: "gdbScript.setIcemanBurnerPort"
                    },
                    {
                        label: "Set Andes ICEman Telnet Port",
                        description: String(icemanConfig.get("telnetPort", ANDES_ICEMAN_DEFAULTS.telnetPort)),
                        command: "gdbScript.setIcemanTelnetPort"
                    },
                    {
                        label: "Set Andes ICEman GDB Port Range",
                        description: String(icemanConfig.get("gdbPortRange", ANDES_ICEMAN_DEFAULTS.gdbPortRange)),
                        command: "gdbScript.setIcemanGdbPortRange"
                    },
                    {
                        label: "Set GDB Target Port",
                        description: String(targetConfig.get("port", GDB_SCRIPT_RUNNER_DEFAULTS.targetPort)),
                        command: "gdbScript.setTargetPort"
                    },
                    {
                        label: "",
                        kind: vscode.QuickPickItemKind.Separator
                    },
                    {
                        label: "Restart Andes ICEman",
                        description: "",
                        command: "gdbScript.restartIceman"
                    },
                    {
                        label: "Exit",
                        description: "Esc",
                        exit: true
                    }
                ],
                {
                    placeHolder: "Select Andes ICEman configuration action"
                }
            );

            if (!selected) {
                return;
            }

            if (selected.exit) {
                return;
            }

            await vscode.commands.executeCommand(selected.command);
        }
    });
}

module.exports = {
    activate,
    deactivate,
    getIcemanConfiguration,
    handleClosedTerminal,
    startIceman,
    stopIceman,
    updateIcemanStatusBar
};
