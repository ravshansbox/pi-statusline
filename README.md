# pi-statusline

Statusline extension for pi.

## Install

```bash
pi install npm:@ravshansbox/pi-statusline
```

Add `-l` to install it in project settings.

## Usage

Pi loads the extension from `./index.ts`. It replaces the built-in footer with a statusline that shows:

- the working directory, git branch and session name
- token usage, cache hit rate, cost and context usage
- the provider, model and thinking level
- statuses set by other extensions

## Development

```bash
npm install
npm run check
```
