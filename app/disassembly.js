const vscode = require("vscode");

function activate(context) {
    const openDisassemblyRightDisposable = vscode.commands.registerCommand(
        "gdbScript.openDisassemblyViewRight",
        async () => {
            await vscode.commands.executeCommand("debug.action.openDisassemblyView");
            await vscode.commands.executeCommand("workbench.action.moveEditorToNextGroup");
        }
    );

    context.subscriptions.push(openDisassemblyRightDisposable);
}

module.exports = {
    activate
};
