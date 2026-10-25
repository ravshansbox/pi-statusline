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
- token usage, cache hit rate and context usage
- statuses set by other extensions, at the end of the line

It also replaces the editor to add shell-style prompt history:

- **Up / Down** recall the previous / next prompt from earlier sessions in the current folder.
- **Ctrl+R** opens reverse search. Type to filter, Up/Down to move, Tab to switch between current-folder and all-folder history, Enter to load the prompt, Esc to cancel. Text already in the editor becomes the initial query.
- Empty prompts, slash commands and inline bash (`!`) are skipped. Repeated prompts keep only their newest position. Each search scope holds up to 500 prompts.

Do not use this with `@ravshansbox/pi-prompt-history`; only one extension can replace the editor.

## Development

```bash
npm install
npm run check
```
