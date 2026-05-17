const vscode = require("vscode");
const { icemanStatusItem, icemanTargetItem, getActiveWorkspaceFolder, getTargetEndpoint, isTargetEndpointAvailable, icemanTerminal, waitForTcpPortOpen, getIcemanConfiguration, buildIcemanArgs, getAndesPaths, buildIcemanEnvironment, buildBashIcemanCommand, buildCmdCommand } = require("./main");
const fs = require("fs");


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
