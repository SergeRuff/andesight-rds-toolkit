const vscode = require("vscode");

function getSelectedExpression(editor) {
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

    return expression;
}

async function showExpressionInMemoryInspector(expression, session) {
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
}

function registerShowMemoryInspectorCommand() {
    return vscode.commands.registerCommand("gdbScript.showMemoryInspector", async () => {
        await vscode.commands.executeCommand("memory-inspector.show");
    });
}

function registerShowSelectedVariableCommand() {
    return vscode.commands.registerCommand("gdbScript.showSelectedVariableInMemoryInspector", async () => {
        const editor = vscode.window.activeTextEditor;
        const session = vscode.debug.activeDebugSession;

        if (!editor || !session) {
            vscode.window.showWarningMessage("No active debug session.");
            return;
        }

        const expression = getSelectedExpression(editor);

        if (!expression) {
            vscode.window.showWarningMessage("No variable selected.");
            return;
        }

        await showExpressionInMemoryInspector(expression, session);
    });
}

function registerShowSelectedPointerTargetCommand() {
    return vscode.commands.registerCommand("gdbScript.showSelectedPointerTargetInMemoryInspector", async () => {
        const editor = vscode.window.activeTextEditor;
        const session = vscode.debug.activeDebugSession;

        if (!editor || !session) {
            vscode.window.showWarningMessage("No active debug session.");
            return;
        }

        const expression = getSelectedExpression(editor);

        if (!expression) {
            vscode.window.showWarningMessage("No variable selected.");
            return;
        }

        await showExpressionInMemoryInspector(`*(${expression})`, session);
    });
}

function activate(context) {
    context.subscriptions.push(
        registerShowMemoryInspectorCommand(),
        registerShowSelectedVariableCommand(),
        registerShowSelectedPointerTargetCommand()
    );
}

module.exports = {
    activate
};
