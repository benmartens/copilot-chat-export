import * as vscode from "vscode";
import * as path from "node:path";
import { parseTranscript } from "./parser";
import { openHtmlPreview } from "./preview";
import { renderTranscriptHtml } from "./renderer";

const COMMAND_ID = "chatTranscriptHtmlPreview.exportActiveChatToHtml";
const COMMAND_SAVE_AS_ID = "chatTranscriptHtmlPreview.exportActiveChatToHtmlSaveAs";

function nowStamp(): string {
  return new Date().toLocaleString();
}

async function captureFocusedChatTranscript(): Promise<string> {
  await vscode.commands.executeCommand("workbench.action.chat.copyAll");
  await new Promise((resolve) => setTimeout(resolve, 120));
  return vscode.env.clipboard.readText();
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getDefaultFileName(): string {
  return `copilot-chat-export-${timestampForFileName()}.html`;
}

async function pickOutputFileUri(fileName: string): Promise<vscode.Uri | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = workspaceRoot
    ? vscode.Uri.joinPath(workspaceRoot, fileName)
    : vscode.Uri.file(path.join(process.cwd(), fileName));

  return vscode.window.showSaveDialog({
    defaultUri,
    filters: {
      "HTML Files": ["html"]
    },
    saveLabel: "Save Chat Export"
  });
}

async function writeHtmlFile(folderUri: vscode.Uri, fileUri: vscode.Uri, html: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(folderUri);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(html));
}

async function openOutput(fileUri: vscode.Uri, title: string, html: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("chatTranscriptHtmlPreview");
  const openTarget = configuration.get<"vscode" | "external">("openTarget", "vscode");

  if (openTarget === "external") {
    await vscode.env.openExternal(fileUri);
    return;
  }

  openHtmlPreview(title, html);
}

async function executeExportFlow(saveAs: boolean): Promise<void> {
  let transcript: string;

  try {
    transcript = await captureFocusedChatTranscript();
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

  const generatedAt = nowStamp();
  const title = `Copilot Chat Export — ${generatedAt}`;
  const html = renderTranscriptHtml(turns, { title, generatedAt });

  if (!saveAs) {
    openHtmlPreview(title, html);
    return;
  }

  const fileName = getDefaultFileName();
  const selectedUri = await pickOutputFileUri(fileName);
  if (!selectedUri) {
    return;
  }

  const outputLocation = {
    folderUri: vscode.Uri.file(path.dirname(selectedUri.fsPath)),
    fileUri: selectedUri
  };

  await writeHtmlFile(outputLocation.folderUri, outputLocation.fileUri, html);
  await openOutput(outputLocation.fileUri, title, html);

  void vscode.window.showInformationMessage(`Copilot chat exported to ${outputLocation.fileUri.fsPath}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const exportDefaultDisposable = vscode.commands.registerCommand(COMMAND_ID, async () => {
    try {
      await executeExportFlow(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to export chat transcript.";
      void vscode.window.showErrorMessage(message);
    }
  });

  const exportSaveAsDisposable = vscode.commands.registerCommand(COMMAND_SAVE_AS_ID, async () => {
    try {
      await executeExportFlow(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to export chat transcript.";
      void vscode.window.showErrorMessage(message);
    }
  });

  context.subscriptions.push(exportDefaultDisposable, exportSaveAsDisposable);
}

export function deactivate(): void {
  // No-op.
}
