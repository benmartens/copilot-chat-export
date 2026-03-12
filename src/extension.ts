import * as path from "node:path";
import * as vscode from "vscode";
import { ChatTurn, parseTranscript } from "./parser";
import {
  ExportLayout,
  ExportRenderOptions,
  ExportTheme,
  renderTranscriptHtml,
  ThinkingMode,
} from "./renderer";
import { ChatInsights, generateInsights } from "./summarizer";

const COMMAND_CUSTOMIZE_ID = "chatTranscriptHtmlPreview.customizeActiveChatAsHtml";
const COMMAND_ID = "chatTranscriptHtmlPreview.exportActiveChatToHtml";
const COMMAND_SAVE_AS_ID = "chatTranscriptHtmlPreview.exportActiveChatToHtmlSaveAs";
const DEFAULT_TITLE = "Copilot Chat Export";

type ExportAction = "preview" | "save";

interface ExportPreferences {
  action: ExportAction;
  thinkingMode: ThinkingMode;
  includeSummary: boolean;
  includeMetadata: boolean;
  includeCodeBlocks: boolean;
  includeLinks: boolean;
  theme: ExportTheme;
  layout: ExportLayout;
}

interface RenderRequest extends ExportPreferences, ExportRenderOptions {
  title: string;
  generatedAt: string;
  version: string;
  summary?: string;
}

interface InsightsCache {
  loaded: boolean;
  value?: ChatInsights;
}

interface WizardOption<T> extends vscode.QuickPickItem {
  value: T;
}

interface ContentOption extends vscode.QuickPickItem {
  key: "includeSummary" | "includeMetadata" | "includeCodeBlocks" | "includeLinks";
}

function slugifyFilePart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug || "copilot-chat-export";
}

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

async function captureTranscriptTurns(): Promise<ChatTurn[]> {
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

  return turns;
}

function getVersion(): string {
  return vscode.extensions.getExtension("local.copilot-chat-export")?.packageJSON.version ?? "dev";
}

function getCustomizeDefaults(config: vscode.WorkspaceConfiguration): ExportPreferences {
  return {
    action: "preview",
    thinkingMode: config.get<ThinkingMode>("builderDefaults.thinkingMode", "hidden"),
    includeSummary: config.get<boolean>("builderDefaults.includeSummary", config.get<boolean>("generateSummary", true)),
    includeMetadata: config.get<boolean>("builderDefaults.includeMetadata", true),
    includeCodeBlocks: config.get<boolean>("builderDefaults.includeCodeBlocks", true),
    includeLinks: config.get<boolean>("builderDefaults.includeLinks", true),
    theme: config.get<ExportTheme>("builderDefaults.theme", "system"),
    layout: "readable",
  };
}

async function showSingleSelect<T>(
  items: readonly WizardOption<T>[],
  options: vscode.QuickPickOptions
): Promise<T | undefined> {
  const selection = await vscode.window.showQuickPick(items, options);
  return selection?.value;
}

async function runCustomizeWizard(defaults: ExportPreferences): Promise<ExportPreferences | undefined> {
  const thinkingOptions: WizardOption<ThinkingMode>[] = [
    {
      label: defaults.thinkingMode === "hidden" ? "$(check) Hide thinking and tool activity" : "Hide thinking and tool activity",
      description: "Omit planning, searches, file reads, and similar activity.",
      value: "hidden",
    },
    {
      label: defaults.thinkingMode === "collapsed" ? "$(check) Collapse thinking and tool activity" : "Collapse thinking and tool activity",
      description: "Group activity into expandable sections.",
      value: "collapsed",
    },
    {
      label: defaults.thinkingMode === "shown" ? "$(check) Show thinking and tool activity inline" : "Show thinking and tool activity inline",
      description: "Render activity as visible transcript content.",
      value: "shown",
    },
  ];

  const thinkingMode = await showSingleSelect(thinkingOptions, {
    title: "Customize Active Chat as HTML (1/5)",
    placeHolder: "How should assistant thinking and tool activity appear?",
    ignoreFocusOut: true,
  });
  if (!thinkingMode) {
    return undefined;
  }

  const contentOptions: ContentOption[] = [
    {
      label: "Summary",
      description: "Add an AI-generated title and summary block.",
      key: "includeSummary",
      picked: defaults.includeSummary,
    },
    {
      label: "Metadata header",
      description: "Show the page title, generated time, and extension version.",
      key: "includeMetadata",
      picked: defaults.includeMetadata,
    },
    {
      label: "Code blocks",
      description: "Keep fenced code blocks in transcript messages.",
      key: "includeCodeBlocks",
      picked: defaults.includeCodeBlocks,
    },
    {
      label: "Links",
      description: "Keep web and file links clickable.",
      key: "includeLinks",
      picked: defaults.includeLinks,
    },
  ];

  const selectedContent = await vscode.window.showQuickPick(contentOptions, {
    title: "Customize Active Chat as HTML (2/5)",
    placeHolder: "What should be included in the export?",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!selectedContent) {
    return undefined;
  }

  const selectedKeys = new Set(selectedContent.map((item) => item.key));

  const themeOptions: WizardOption<ExportTheme>[] = [
    {
      label: defaults.theme === "system" ? "$(check) System" : "System",
      description: "Follow the viewer's light or dark preference.",
      value: "system",
    },
    {
      label: defaults.theme === "light" ? "$(check) Light" : "Light",
      description: "Always render the export with a light theme.",
      value: "light",
    },
    {
      label: defaults.theme === "dark" ? "$(check) Dark" : "Dark",
      description: "Always render the export with a dark theme.",
      value: "dark",
    },
  ];

  const theme = await showSingleSelect(themeOptions, {
    title: "Customize Active Chat as HTML (3/5)",
    placeHolder: "Which theme should the export use?",
    ignoreFocusOut: true,
  });
  if (!theme) {
    return undefined;
  }

  const actionOptions: WizardOption<ExportAction>[] = [
    {
      label: defaults.action === "preview" ? "$(check) Preview in VS Code" : "Preview in VS Code",
      description: "Open the rendered HTML in an editor preview.",
      value: "preview",
    },
    {
      label: defaults.action === "save" ? "$(check) Save as HTML file" : "Save as HTML file",
      description: "Choose a destination and write one HTML file.",
      value: "save",
    },
  ];

  const action = await showSingleSelect(actionOptions, {
    title: "Customize Active Chat as HTML (4/4)",
    placeHolder: "Preview in VS Code or save as HTML file?",
    ignoreFocusOut: true,
  });
  if (!action) {
    return undefined;
  }

  const preferences: ExportPreferences = {
    action,
    thinkingMode,
    includeSummary: selectedKeys.has("includeSummary"),
    includeMetadata: selectedKeys.has("includeMetadata"),
    includeCodeBlocks: selectedKeys.has("includeCodeBlocks"),
    includeLinks: selectedKeys.has("includeLinks"),
    theme,
    layout: "readable",
  };

  return preferences;
}

async function buildRenderRequest(
  turns: ChatTurn[],
  preferences: ExportPreferences,
  options?: { insightsCache?: InsightsCache; showSummaryProgress?: boolean }
): Promise<RenderRequest> {
  let title = DEFAULT_TITLE;
  let summary: string | undefined;

  if (preferences.includeSummary) {
    const cache = options?.insightsCache;

    if (cache?.loaded) {
      title = cache.value?.title ?? DEFAULT_TITLE;
      summary = cache.value?.summary;
    } else {
      const loadInsights = async (): Promise<ChatInsights | undefined> => generateInsights(turns);
      const insights = options?.showSummaryProgress === false
        ? await loadInsights()
        : await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Generating chat summary...",
            },
            loadInsights
          );

      if (cache) {
        cache.loaded = true;
        cache.value = insights;
      }

      if (insights) {
        title = insights.title;
        summary = insights.summary;
      }
    }
  }

  return {
    ...preferences,
    title,
    generatedAt: new Date().toLocaleString(),
    version: getVersion(),
    summary,
  };
}

async function renderExport(
  turns: ChatTurn[],
  preferences: ExportPreferences,
  options?: { insightsCache?: InsightsCache; showSummaryProgress?: boolean }
): Promise<{ request: RenderRequest; html: string }> {
  const request = await buildRenderRequest(turns, preferences, options);
  const html = renderTranscriptHtml(turns, request);
  return { request, html };
}

async function writeOrPreviewExport(
  title: string,
  html: string,
  action: ExportAction,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  if (action === "preview") {
    openHtmlPreview(title, html);
    return;
  }

  const fileName = `${slugifyFilePart(title)}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
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

  const openTarget = config.get<"vscode" | "external">("openTarget", "vscode");
  if (openTarget === "external") {
    await vscode.env.openExternal(selectedUri);
  } else {
    openHtmlPreview(title, html);
  }

  void vscode.window.showInformationMessage(`Copilot chat exported to ${selectedUri.fsPath}`);
}

async function executeExportFlow(saveAs: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration("chatTranscriptHtmlPreview");
  const turns = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Capturing active chat transcript...",
    },
    () => captureTranscriptTurns()
  );

  const preferences: ExportPreferences = {
    ...getCustomizeDefaults(config),
    action: saveAs ? "save" : "preview",
  };

  const { request, html } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Generating chat export...",
    },
    () => renderExport(turns, preferences, { showSummaryProgress: false })
  );

  await writeOrPreviewExport(request.title, html, request.action, config);
}

async function executeCustomizeFlow(): Promise<void> {
  const config = vscode.workspace.getConfiguration("chatTranscriptHtmlPreview");
  const turns = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Capturing active chat transcript...",
    },
    () => captureTranscriptTurns()
  );

  const preferences = await runCustomizeWizard(getCustomizeDefaults(config));
  if (!preferences) {
    return;
  }

  const insightsCache: InsightsCache = { loaded: false };
  const { request, html } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Generating chat export...",
    },
    () => renderExport(turns, preferences, { insightsCache, showSummaryProgress: false })
  );

  await writeOrPreviewExport(request.title, html, request.action, config);
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
    vscode.commands.registerCommand(COMMAND_CUSTOMIZE_ID, wrap(() => executeCustomizeFlow())),
    vscode.commands.registerCommand(COMMAND_ID, wrap(() => executeExportFlow(false))),
    vscode.commands.registerCommand(COMMAND_SAVE_AS_ID, wrap(() => executeExportFlow(true)))
  );
}
