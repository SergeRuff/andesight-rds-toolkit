const vscode = require("vscode");

class ProjectView_Provider {
  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = `
      <html>
        <body>
          <h1>AndeSight RDS</h1>
          <p>Projects are supposed to be displayed here...</p>
          <p>Now there is no content to display.</p>
        </body>
      </html>
    `;
  }
}

function activate(context) {
  console.log("RDS Toolkit: registerWebviewViewProvider andesRds.projectView");
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "andesRds.projectView",
      new ProjectView_Provider()
    )
  );
}

module.exports = {
  activate
};