const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const ICEman = require("#app/iceman");
const memInspect = require("#app/mem_inspect");
const disassembly = require("#app/disassembly");
const gdbRunner = require("#app/gdb_runner");
const logger = require("#app/logger");

let templatesDir;

function getWorkspaceFolderForCommand(editor) {
    if (editor) {
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

        if (folder) {
            return folder;
        }
    }

    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
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

async function activate(context) {
    templatesDir = path.join(context.extensionPath, "templates");

    ICEman.activate(context, { getWorkspaceFolderForCommand });
    memInspect.activate(context);
    disassembly.activate(context);
    gdbRunner.activate(context, {
        ensureIcemanStartedForDebug: ICEman.ensureStartedForDebug,
        logger
    });

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

    context.subscriptions.push(regenerateLaunchDisposable);
}

function deactivate() {
    gdbRunner.deactivate();
    ICEman.deactivate();
}

module.exports = {
    activate,
    deactivate
};
