# pi-statusline

Statusline extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-statusline
```

Add `-l` to install it in project settings.

## Usage

Pi loads the extension from `./index.ts`. It replaces the built-in footer with a statusline that shows:

- the directory name, git branch, model and thinking level
- token usage, cache hit rate and context usage
- statuses set by other extensions

## Development

```bash
npm install
npm run check
```
