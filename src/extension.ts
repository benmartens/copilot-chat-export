import * as vscode from "vscode";
import * as path from "node:path";
import { parseTranscript } from "./parser";
import { renderTranscriptHtml } from "./renderer";

const COMMAND_ID = "chatTranscriptHtmlPreview.exportActiveChatToHtml";
const COMMAND_SAVE_AS_ID = "chatTranscriptHtmlPreview.exportActiveChatToHtmlSaveAs";

function openHtmlPreview(title: string, html: string): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "chatTranscriptHtmlPreview",
    title,
    { preserveFocus: false, viewColumn: vscode.ViewColumn.Active },
    { enableFindWidget: true, retainContextWhenHidden: true }
  );
  panel.webview.html = html;
  return panel;
}

async function executeExportFlow(saveAs: boolean): Promise<void> {
  let transcript: string;

  try {
    await vscode.commands.executeCommand("workbench.action.chat.copyAll");
    await new Promise((resolve) => setTimeout(resolve, 120));
    transcript = await vscode.env.clipboard.readText();
  } catch {
    throw new Error("Could not run Chat: Copy All. Focus the Copilot Chat view and try again.");
  }

  if (!transcript || transcript.trim().length === 0) {
    throw new Error("No transcript text was captured. Focus the active Copilot chat and run the command again.");
  }

  const turns = parseTranscript(transcript);
  if (turns.length === 0) {
    throw new Error("Transcript was captured but no messages were detected.");
  }

  const generatedAt = new Date().toLocaleString();
  const title = `Copilot Chat Export — ${generatedAt}`;
  const html = renderTranscriptHtml(turns, { title, generatedAt });

  if (!saveAs) {
    openHtmlPreview(title, html);
    return;
  }

  const fileName = `copilot-chat-export-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = workspaceRoot
    ? vscode.Uri.joinPath(workspaceRoot, fileName)
    : vscode.Uri.file(path.join(process.cwd(), fileName));

  const selectedUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { "HTML Files": ["html"] },
    saveLabel: "Save Chat Export",
  });
  if (!selectedUri) {
    return;
  }

  const folderUri = vscode.Uri.file(path.dirname(selectedUri.fsPath));
  await vscode.workspace.fs.createDirectory(folderUri);
  await vscode.workspace.fs.writeFile(selectedUri, new TextEncoder().encode(html));

  const openTarget = vscode.workspace.getConfiguration("chatTranscriptHtmlPreview").get<"vscode" | "external">("openTarget", "vscode");
  if (openTarget === "external") {
    await vscode.env.openExternal(selectedUri);
  } else {
    openHtmlPreview(title, html);
  }

  void vscode.window.showInformationMessage(`Copilot chat exported to ${selectedUri.fsPath}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const wrap = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to export chat transcript.";
      void vscode.window.showErrorMessage(message);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, wrap(() => executeExportFlow(false))),
    vscode.commands.registerCommand(COMMAND_SAVE_AS_ID, wrap(() => executeExportFlow(true)))
  );
}
