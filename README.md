# Chat Transcript HTML Preview

Local VS Code extension to quick-export the currently focused Copilot chat as a fully self-contained HTML page.

## What it does

- Runs from Command Palette in one step.
- Triggers `Chat: Copy All` for the focused chat view.
- Parses the copied transcript into turns.
- Opens a preview of the rendered HTML without writing a file.
- Saves an `.html` file only when you use the Save As command.

## Usage

1. Open Copilot Chat and make sure the chat input/view is focused.
2. Run one of these commands:
	- `Chat Transcript: Preview Active Chat as HTML` (preview only, no file written)
	- `Chat Transcript: Save Active Chat to HTML As...` (choose any destination)
3. The preview command opens an in-editor preview. The Save As command writes one HTML file and opens it.

## Setting

- `chatTranscriptHtmlPreview.openTarget`
	- `vscode` (default): opens in an in-editor preview
	- `external`: for Save As, opens the saved file in your default browser

## Notes

- This extension uses clipboard-based capture because public APIs do not expose arbitrary active Copilot session history directly.
- If the command cannot capture text, focus the chat view and rerun.

## Local development

- Install dependencies: `npm install`
- Build: `npm run compile`
- Launch Extension Development Host: press `F5` in VS Code.
