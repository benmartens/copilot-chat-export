import * as vscode from "vscode";

export function openHtmlPreview(title: string, html: string): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "chatTranscriptHtmlPreview",
    title,
    {
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.Active
    },
    {
      enableFindWidget: true,
      retainContextWhenHidden: true
    }
  );

  panel.webview.html = html;
  return panel;
}
