const vscode = require("vscode");

class ToolsProvider {
  getTreeItem(element) {
    return new vscode.TreeItem(element.label, element.collapsibleState);
  }

  getChildren(element) {
    if (!element) {
      return [
        { label: "Tool 1", collapsibleState: vscode.TreeItemCollapsibleState.None },
        { label: "Tool 2", collapsibleState: vscode.TreeItemCollapsibleState.None }
      ];
    }
    return [];
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "andesRds.tools",
      new ToolsProvider()
    )
  );
}

module.exports = {
  activate
};