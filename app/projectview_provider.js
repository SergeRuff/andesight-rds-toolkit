const vscode = require("vscode");

class ProjectView_Provider {
  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = `
      <html>
        <body>
          <h1>AndeSight RDS</h1>
          <p>Данные тут...</p>
        </body>
      </html>
    `;
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "andesRds.projectview",
      new ProjectView_Provider()
    )
  );
}

module.exports = {
  activate
};