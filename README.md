# pi-statusline

Statusline and prompt history extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-statusline
```

Add `-l` to install it in project settings.

## Usage

Pi loads the extension from `./index.ts`. It replaces the built-in footer with a statusline that shows:

- the directory name, git branch, model and thinking level
- token usage, cache hit rate (only when below 80%) and context usage
- statuses set by other extensions, at the end of the line

Parts wrap onto the next line when the screen is too narrow. A part wider than the screen is cut short with `...`.

It also replaces the editor to add shell-style prompt history:

- **Up / Down** recall the previous / next prompt from earlier sessions in the current folder.
- **Ctrl+R** opens reverse search. Type to filter, Up/Down to move, Tab to switch between current-folder and all-folder history, Enter to load the prompt, Esc to cancel. Text already in the editor becomes the initial query.
- Slash commands and inline bash (`!` and `!!`) are recalled too. Pi saves bash commands in the session, so they come back from earlier sessions. Most slash commands are not saved, so they come back only from the current session. Empty prompts and expanded `/skill:` commands are skipped. Repeated prompts keep only their newest position. Prompts that pi replays when you resume a session or move in the tree keep their place. Up / Down reaches the newest 100 prompts. Each reverse search scope holds up to 500 prompts.

It also shows the session name at the right of the editor's top border. The name comes from `/name` or from the `set_session_name` tool, which the model is asked to call (in the TUI and RPC modes, not in JSON or print mode) on the first user prompt and again whenever the topic or task changes. The tool call and its output are hidden from the transcript. Long names are shortened to fit.

The editor border uses the theme's `dim` colour for every thinking level, to match the statusline. In bash mode (`!`), it keeps the theme's bash mode colour. Status indicators in the border, such as Working, are also `dim`. When the agent is idle, the border shows Ready.

Do not use this with `@ravshansbox/pi-prompt-history`; only one extension can replace the editor.

## Development

```bash
npm install
npm run check
```
