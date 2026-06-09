const vscode = require("vscode");

class ToolsProvider {
  constructor(context) {
    this.context = context;
  }

  getTreeItem(element) {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    if (element.icon) {
      // Use a ThemeIcon so built-in codicons are shown in the tree
      try {
        item.iconPath = new vscode.ThemeIcon(element.icon);
      } catch (e) {
        // fallback: do nothing
      }
    }
    return item;
  }

  getChildren(element) {
    if (!element) {
      return [
        { 
            label: "Run Job",
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            icon: "debug-start"
        },
        { 
            label: "Tool Select",
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            icon: "tools"
        },
        { 
            label: "Open Report",
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            icon: "notebook-render-output"
        }
      ];
    }
    return [];
  }
}

function activate(context) {  console.log("RDS Toolkit: registerTreeDataProvider andesRds.tools");  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "andesRds.tools",
      new ToolsProvider(context)
    )
  );
}

module.exports = {
  activate
};