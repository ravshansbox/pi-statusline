import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { renderFakeCursor, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import extension from './index.ts';

const agentDir = mkdtempSync(join(tmpdir(), 'pi-statusline-'));
process.env['PI_CODING_AGENT_DIR'] = agentDir;
initTheme('dark');

type Component = {
  render(width: number): string[];
  handleInput(data: string): void;
  getText(): string;
  addToHistory?(text: string): void;
};
type Factory = (tui: unknown, theme: unknown, footerData: unknown) => Component;
type CustomFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (value: string | null) => void,
) => Component;
type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
  name: string;
  promptGuidelines?: string[];
  execute: (id: string, params: { name: string }) => Promise<unknown>;
  renderShell?: string;
  renderCall?: (...args: unknown[]) => Component;
  renderResult?: (...args: unknown[]) => Component;
};

type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

function fakePi(sessionName?: string) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const registered: string[] = [];
  const names: string[] = [];
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, h);
    },
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
      registered.push(tool.name);
    },
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    setSessionName: (name: string) => {
      names.push(name);
    },
    getSessionName: () => sessionName,
  } as unknown as ExtensionAPI;
  extension(pi);
  return { handlers, tools, commands, registered, names };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite };
}

function render(options: {
  entries?: unknown[];
  branchEntries?: unknown[];
  leafId?: () => string | null;
  branch?: string | null;
  statuses?: Map<string, string>;
  width?: number;
  thinkingLevel?: string;
  percent?: number;
  theme?: typeof theme;
  onRendered?: (rerender: () => string[]) => void;
}): string[] {
  const { handlers } = fakePi();

  let factory: Factory | undefined;
  const model = {
    id: 'claude-opus',
    provider: 'anthropic',
    reasoning: true,
    contextWindow: 200000,
  };
  const ctx = {
    mode: 'tui',
    hasUI: true,
    model,
    thinkingLevel: options.thinkingLevel ?? 'high',
    ui: {
      setFooter: (f: Factory) => {
        factory = f;
      },
      setEditorComponent: () => {},
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getBranch: () => options.branchEntries ?? options.entries ?? [],
      getLeafId: options.leafId ?? (() => null),
      getCwd: () => '/tmp/project',
      getSessionDir: () => defaultSessionDir('/tmp/project'),
      getSessionName: () => undefined,
    },
    modelRegistry: {
      isUsingOAuth: () => false,
      getProvider: () => undefined,
    },
    getContextUsage: () => ({
      tokens: 50000,
      contextWindow: 200000,
      percent: options.percent ?? 25,
    }),
  };
  handlers.get('session_start')?.({ type: 'session_start' }, ctx);
  assert.ok(factory);

  const footerData = {
    getGitBranch: () => options.branch ?? null,
    getExtensionStatuses: () => options.statuses ?? new Map(),
    onBranchChange: () => () => {},
  };
  const footer = factory({ requestRender: () => {} }, options.theme ?? theme, footerData);
  const lines = footer.render(options.width ?? 80);
  options.onRendered?.(() => footer.render(options.width ?? 80));
  return lines;
}

const tui = { terminal: { rows: 40, columns: 80 }, requestRender: () => {} };
const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};
const keybindings = { matches: () => false };
const themed = (color: string, text: string) => `\x1b[${color === 'dim' ? 2 : 90}m${text}\x1b[39m`;

let sessionCount = 0;
function defaultSessionDir(cwd: string) {
  return join(agentDir, 'sessions', `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`);
}

type Prompt = string | { bash: string; exclude?: boolean };

function writeSession(
  cwd: string,
  prompts: Prompt[],
  times?: string[],
  dir = defaultSessionDir(cwd),
) {
  mkdirSync(dir, { recursive: true });
  sessionCount++;
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, sessionCount)).toISOString();
  const lines = [
    { type: 'session', version: 3, id: `s${sessionCount}`, timestamp, cwd },
    ...prompts.map((content, i) => ({
      type: 'message',
      id: `m${i}`,
      parentId: i === 0 ? null : `m${i - 1}`,
      timestamp: times?.[i] ?? timestamp,
      message:
        typeof content === 'string'
          ? { role: 'user', content, timestamp: times ? Date.parse(times[i]!) : 0 }
          : {
              role: 'bashExecution',
              command: content.bash,
              output: '',
              exitCode: 0,
              cancelled: false,
              truncated: false,
              excludeFromContext: content.exclude,
              timestamp: 0,
            },
    })),
  ];
  const file = join(dir, `${sessionCount}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

type Complete = (
  model: unknown,
  context: unknown,
  options: { signal: AbortSignal },
) => Promise<unknown>;

async function startEditor(
  cwd: string,
  sessionName?: string,
  sessionDir = defaultSessionDir(cwd),
  options: { branch?: unknown[]; complete?: Complete } = {},
) {
  const { handlers, commands } = fakePi(sessionName);
  const submitted: string[] = [];
  const notifications: string[] = [];

  let editorFactory: ((tui: unknown, theme: unknown, kb: unknown) => Component) | undefined;
  let search: Component | undefined;
  let editorText: (text: string) => void = () => {};
  const editorTextSet = new Promise<string>((resolve) => {
    editorText = resolve;
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => options.branch ?? [],
      getCwd: () => cwd,
      getSessionDir: () => sessionDir,
    },
    model: { id: 'claude-opus', provider: 'anthropic' },
    modelRegistry: { complete: options.complete ?? (async () => ({ content: [] })) },
    getContextUsage: () => undefined,
    ui: {
      theme: { fg: themed },
      setFooter: () => {},
      setEditorComponent: (f: typeof editorFactory) => {
        editorFactory = f;
      },
      getEditorText: () => editor.getText(),
      setEditorText: (text: string) => editorText(text),
      notify: (message: string) => notifications.push(message),
      custom: (f: CustomFactory) =>
        new Promise((resolve) => {
          search = f(tui, theme, keybindings, resolve);
        }),
    },
  };
  await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
  assert.ok(editorFactory);
  const editor = editorFactory(tui, editorTheme, keybindings);
  (editor as Component & { onSubmit?: (text: string) => void }).onSubmit = (text) => {
    submitted.push(text);
    editor.addToHistory?.(text);
  };
  return {
    editor,
    handlers,
    commands,
    ctx,
    submitted,
    notifications,
    getSearch: () => search,
    editorTextSet,
  };
}

async function allFoldersLoaded(search: Component) {
  while (search.render(80).some((line) => line.includes('loading…'))) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function send(editor: Component, text: string) {
  for (const key of text) editor.handleInput(key);
  editor.handleInput('\r');
}

test('recalls prompts from earlier sessions in the same folder with up', async () => {
  writeSession('/work/recall', ['first', 'second']);
  writeSession('/work/other', ['elsewhere']);
  const { editor } = await startEditor('/work/recall');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'second');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first');
});

test('recalls slash commands and bash commands from earlier sessions with up', async () => {
  writeSession('/work/commands', [
    '/review the diff',
    { bash: 'ls' },
    { bash: 'git status', exclude: true },
  ]);
  const { editor } = await startEditor('/work/commands');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), '!!git status');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), '!ls');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), '/review the diff');
});

test('finds slash commands and bash commands sent in this session in reverse search', async () => {
  const { editor, getSearch, editorTextSet } = await startEditor('/work/commands-here');
  send(editor, '/deploy now');
  send(editor, '!ls');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  for (const key of 'deploy') search.handleInput(key);
  search.handleInput('\r');
  assert.equal(await editorTextSet, '/deploy now');
});

test('finds slash commands sent in this session in all-folder reverse search', async () => {
  writeSession('/work/commands-all-b', ['elsewhere']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/commands-all-a');
  send(editor, '/deploy now');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  await allFoldersLoaded(search);
  search.handleInput('\r');
  assert.equal(await editorTextSet, '/deploy now');
});

test('skips expanded skill commands from earlier sessions in up history', async () => {
  writeSession('/work/skill', [
    'first',
    '<skill name="demo" location="/skills/demo/SKILL.md">\nReferences are relative to /skills/demo.\n\nbody\n</skill>\n\ndo it',
  ]);
  const { editor } = await startEditor('/work/skill');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first');
});

test('skips expanded skill commands replayed from a resumed session in up history', async () => {
  writeSession('/work/skill-replay', ['first']);
  const { editor } = await startEditor('/work/skill-replay');
  (editor as Component & { addToHistory(text: string): void }).addToHistory(
    '<skill name="demo" location="/skills/demo/SKILL.md">\nbody\n</skill>\n\ndo it',
  );
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first');
});

test('recalls a prompt sent again only at its newest position with up', async () => {
  writeSession('/work/repeat', ['first', 'second']);
  const { editor } = await startEditor('/work/repeat');
  send(editor, 'first');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'second');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'second');
});

test('keeps prompts replayed from a resumed session in place in up history', async () => {
  writeSession('/work/replay-up', ['resumed prompt']);
  writeSession('/work/replay-up', ['newer prompt']);
  const { editor } = await startEditor('/work/replay-up');
  editor.addToHistory?.('resumed prompt');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'newer prompt');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'resumed prompt');
});

test('loads a prompt chosen in reverse search with ctrl+r', async () => {
  writeSession('/work/search', ['fix the build', 'write the docs']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/search');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  for (const key of 'build') search.handleInput(key);
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'fix the build');
});

test('filters reverse search by pasted text', async () => {
  writeSession('/work/paste', ['deploy app', 'run tests']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/paste');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\x1b[200~deploy\x1b[201~');
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'deploy app');
});

test('filters reverse search by typed characters outside the basic plane', async () => {
  writeSession('/work/emoji', ['ship it 🚀', 'run tests']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/emoji');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('🚀');
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'ship it 🚀');
});

test('removes a whole character outside the basic plane on backspace in reverse search', async () => {
  writeSession('/work/emoji-backspace', ['ship it 🚀', 'run tests']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/emoji-backspace');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('r');
  search.handleInput('🚀');
  search.handleInput('\x7f');
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'run tests');
});

test('filters reverse search by characters typed as Kitty key codes', async () => {
  writeSession('/work/kitty', ['run tests', 'deploy app']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/kitty');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\x1b[114u');
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'run tests');
});

test('reports an error when reverse search cannot open', async () => {
  const { editor, ctx, notifications } = await startEditor('/work/search-error');
  (ctx.ui as { custom: unknown }).custom = () => Promise.reject(new Error('no UI'));
  editor.handleInput('\x12');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ['Could not open reverse search: no UI']);
});

test('shows the working indicator in the editor border', async () => {
  const { editor } = await startEditor('/work/status');
  const indicator = { renderInBorder: () => 'Working', render: () => [], invalidate: () => {} };
  (
    editor as unknown as { setWorkingStatusIndicator: (i: unknown) => void }
  ).setWorkingStatusIndicator(indicator);
  assert.match(editor.render(80)[0] ?? '', /Working/);
});

test('dims the working indicator in the editor border', async () => {
  const { editor } = await startEditor('/work/status-dim');
  const indicator = {
    renderInBorder: () => '\x1b[36m\u280b\x1b[39m \x1b[90mWorking\x1b[39m',
    renderSpinnerInBorder: () => '\x1b[36m\u280b\x1b[39m',
    render: () => [],
    invalidate: () => {},
  };
  (
    editor as unknown as { setWorkingStatusIndicator: (i: unknown) => void }
  ).setWorkingStatusIndicator(indicator);
  assert.ok(editor.render(40)[0]?.includes(themed('dim', '\u280b Working')));
  assert.ok(editor.render(3)[0]?.includes(themed('dim', '\u280b')));
});

test('shows Ready in the editor border when idle', async () => {
  const { editor } = await startEditor('/work/status-ready');
  assert.ok(editor.render(40)[0]?.includes(themed('dim', 'Ready')));
});

test('shows Ready again when the working indicator clears', async () => {
  const { editor } = await startEditor('/work/status-ready-again');
  const setIndicator = (
    editor as unknown as { setWorkingStatusIndicator: (i: unknown) => void }
  ).setWorkingStatusIndicator.bind(editor);
  setIndicator({ renderInBorder: () => 'Working', render: () => [], invalidate: () => {} });
  setIndicator(undefined);
  const top = editor.render(40)[0] ?? '';
  assert.match(top, /Ready/);
  assert.doesNotMatch(top, /Working/);
});

async function startSession(mode: string, starts = 1) {
  const { handlers, tools, registered, names } = fakePi();
  const cwd = '/work/session-tools';
  const customised: string[] = [];
  for (let i = 0; i < starts; i++) {
    await handlers.get('session_start')?.(
      { type: 'session_start' },
      {
        mode,
        hasUI: mode === 'tui' || mode === 'rpc',
        sessionManager: { getCwd: () => cwd, getSessionDir: () => defaultSessionDir(cwd) },
        ui: {
          setFooter: () => customised.push('footer'),
          setEditorComponent: () => customised.push('editor'),
        },
      },
    );
  }
  return { tools, registered, names, customised };
}

test('offers the set_session_name tool once across new sessions', async () => {
  const { registered } = await startSession('tui', 3);
  assert.deepEqual(registered, ['set_session_name']);
});

test('offers the set_session_name tool in RPC mode without the TUI footer or editor', async () => {
  const { tools, customised } = await startSession('rpc');
  assert.ok(tools.has('set_session_name'));
  assert.deepEqual(customised, []);
});

test('does not offer the set_session_name tool without a UI', async () => {
  for (const mode of ['print', 'json']) {
    const { tools } = await startSession(mode);
    assert.equal(tools.has('set_session_name'), false, mode);
  }
});

test('names the session with the set_session_name tool', async () => {
  const { tools, names } = await startSession('tui');
  const tool = tools.get('set_session_name');
  assert.ok(tool);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /set_session_name.*first user prompt/);
  await tool.execute('call-1', { name: 'fix login bug' });
  assert.deepEqual(names, ['fix login bug']);
});

test('hides the set_session_name tool call and output', async () => {
  const { tools } = await startSession('tui');
  const tool = tools.get('set_session_name');
  assert.equal(tool?.renderShell, 'self');
  const call = tool?.renderCall?.({ name: 'fix login bug' }, theme, {});
  const result = { content: [{ type: 'text', text: 'Session named: fix login bug' }] };
  const output = tool?.renderResult?.(result, {}, theme, {});
  assert.deepEqual(call?.render(80), []);
  assert.deepEqual(output?.render(80), []);
});

test('shows the session name at the right of the editor border', async () => {
  const { editor } = await startEditor('/work/name', 'fix login bug');
  const top = editor.render(40)[0] ?? '';
  assert.ok(stripTerminalSequences(top).endsWith(' fix login bug ──'), top);
  assert.equal(visibleWidth(top), 40);
});

test('draws the editor border in the dim theme colour', async () => {
  const { editor } = await startEditor('/work/border');
  (editor as unknown as { borderColor: (t: string) => string }).borderColor = (t) =>
    `<thinkingMedium>${t}</thinkingMedium>`;
  const lines = editor.render(20);
  assert.equal(stripTerminalSequences(lines[0] ?? ''), `── Ready ${'─'.repeat(11)}`);
  assert.ok(lines[0]?.startsWith(themed('dim', '── ')));
  assert.equal(lines.at(-1), themed('dim', '─'.repeat(20)));
});

test('keeps the bash mode editor border colour', async () => {
  const { editor } = await startEditor('/work/bash');
  for (const key of '!ls') editor.handleInput(key);
  (editor as unknown as { borderColor: (t: string) => string }).borderColor = (t) =>
    `<bashMode>${t}</bashMode>`;
  const top = editor.render(20)[0] ?? '';
  assert.ok(top.startsWith('<bashMode>── </bashMode>'), top);
  assert.ok(top.endsWith(`<bashMode> ${'─'.repeat(11)}</bashMode>`), top);
});

test('shows the session name next to the working indicator', async () => {
  const { editor } = await startEditor('/work/name-working', 'fix login bug');
  const indicator = { renderInBorder: () => 'Working', render: () => [], invalidate: () => {} };
  (
    editor as unknown as { setWorkingStatusIndicator: (i: unknown) => void }
  ).setWorkingStatusIndicator(indicator);
  const top = editor.render(40)[0] ?? '';
  assert.match(top, /Working/);
  assert.ok(stripTerminalSequences(top).endsWith(' fix login bug ──'), top);
});

test('shortens the session name when the border is narrow', async () => {
  const { editor } = await startEditor('/work/name-narrow', 'a very long session name');
  const top = editor.render(24)[0] ?? '';
  assert.match(top, /a very.*…/);
  assert.ok(stripTerminalSequences(top).endsWith(' ──'), top);
  assert.equal(visibleWidth(top), 24);
});

test('shows the directory name, git branch, model and thinking level', () => {
  assert.equal(render({ branch: 'main' })[0], 'project • main • opus:high • 25%/200k');
});

test('shows off when thinking is off', () => {
  assert.equal(render({ thinkingLevel: 'off' })[0], 'project • opus:off • 25%/200k');
});

test('leaves out the git branch outside a repository', () => {
  assert.equal(render({})[0], 'project • opus:high • 25%/200k');
});

test('shows token usage and context', () => {
  const line = render({
    entries: [
      {
        type: 'message',
        message: { role: 'assistant', usage: usage(8, 1400, 26000, 7000) },
      },
    ],
  })[0];
  assert.equal(line, 'project • opus:high • 25%/200k • ↑8 ↓1k R26k W7k CH79%');
});

test('hides cache hit rate when it rounds to 80% or above', () => {
  const line = render({
    entries: [
      {
        type: 'message',
        message: { role: 'assistant', usage: usage(8, 1400, 7960, 2040) },
      },
    ],
  })[0];
  assert.equal(line, 'project • opus:high • 25%/200k • ↑8 ↓1k R8k W2k');
});

test('takes the cache hit rate from the current branch and totals from all branches', () => {
  const here = { type: 'message', message: { role: 'assistant', usage: usage(50, 0, 50) } };
  const elsewhere = { type: 'message', message: { role: 'assistant', usage: usage(10, 0, 90) } };
  const line = render({ entries: [here, elsewhere], branchEntries: [here] })[0];
  assert.equal(line, 'project • opus:high • 25%/200k • ↑60 R140 CH50%');
});

test('updates token usage only when the session changes', () => {
  const entries: unknown[] = [
    { type: 'message', message: { role: 'assistant', usage: usage(8, 0) } },
  ];
  let leaf = 'a';
  let reads = 0;
  let rerender: () => string[] = () => [];
  render({
    entries: new Proxy(entries, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) reads++;
        return Reflect.get(target, key, receiver);
      },
    }),
    branchEntries: [],
    leafId: () => leaf,
    onRendered: (r) => {
      rerender = r;
    },
  });
  assert.equal(rerender()[0], 'project • opus:high • 25%/200k • ↑8');
  assert.equal(reads, 1);
  entries.push({ type: 'message', message: { role: 'assistant', usage: usage(2, 0) } });
  leaf = 'b';
  assert.equal(rerender()[0], 'project • opus:high • 25%/200k • ↑10');
  assert.equal(reads, 2);
});

test('shows extension statuses sorted by key at the end of the line', () => {
  const statuses = new Map([
    ['b', 'second'],
    ['a', 'first\nline'],
  ]);
  assert.deepEqual(render({ statuses }), ['project • opus:high • 25%/200k • first line • second']);
});

test('wraps parts onto the next line when the line does not fit', () => {
  const statuses = new Map([
    ['a', 'quota 42%'],
    ['b', 'second'],
  ]);
  assert.deepEqual(render({ statuses, width: 40 }), [
    'project • opus:high • 25%/200k',
    'quota 42% • second',
  ]);
  assert.deepEqual(render({ statuses, width: 20 }), [
    'project • opus:high',
    '25%/200k • quota 42%',
    'second',
  ]);
  assert.deepEqual(render({ statuses, width: 8 }).map(stripTerminalSequences), [
    'project',
    'opus:...',
    '25%/200k',
    'quota...',
    'second',
  ]);
});

test('shows high context usage in dim', () => {
  const tagTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
    bold: (text: string) => text,
  };
  const line = render({
    percent: 95,
    width: 200,
    theme: tagTheme,
    entries: [{ type: 'message', message: { role: 'assistant', usage: usage(8, 0) } }],
  })[0];
  assert.ok(line);
  let colour = '';
  const colours: string[] = [];
  for (const part of line.split(/(<\w+>|<\/>)/)) {
    if (part === '</>') colour = '';
    else if (/^<\w+>$/.test(part)) colour = part.slice(1, -1);
    else colours.push(...[...part].map(() => colour));
  }
  const plain = line.replace(/<\w+>|<\/>/g, '');
  assert.equal(plain, 'project • opus:high • 95%/200k • ↑8');
  assert.equal(colours[plain.indexOf('95%')], 'dim');
  assert.equal(colours[plain.indexOf('↑8')], 'dim');
});

test('orders all-folder reverse search by recency', async () => {
  writeSession('/work/order-a', ['older here']);
  writeSession('/work/order-b', ['newer elsewhere']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/order-a');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  await allFoldersLoaded(search);
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'newer elsewhere');
});

test('puts a prompt sent again in this session first in all-folder reverse search', async () => {
  writeSession('/work/resend-a', ['sent again']);
  writeSession('/work/resend-b', ['newer elsewhere']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/resend-a');
  send(editor, 'sent again');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  await allFoldersLoaded(search);
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'sent again');
});

test('does not put prompts replayed from a resumed session first in all-folder reverse search', async () => {
  writeSession('/work/replay-a', ['resumed prompt']);
  writeSession('/work/replay-b', ['newer elsewhere']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/replay-a');
  (editor as Component & { addToHistory(text: string): void }).addToHistory('resumed prompt');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  await allFoldersLoaded(search);
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'newer elsewhere');
});

test('orders prompts from sessions run side by side by when they were sent with up', async () => {
  writeSession(
    '/work/parallel',
    ['first in a', 'third in a'],
    ['2026-02-01T00:00:00.000Z', '2026-02-03T00:00:00.000Z'],
  );
  writeSession('/work/parallel', ['second in b'], ['2026-02-02T00:00:00.000Z']);
  const { editor } = await startEditor('/work/parallel');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'third in a');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'second in b');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first in a');
});

test('keeps the current-folder selection when all-folder history finishes loading', async () => {
  writeSession('/work/keep-a', ['older here', 'newer here']);
  writeSession('/work/keep-b', ['elsewhere']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/keep-a');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  search.handleInput('\t');
  search.handleInput('\x1b[B');
  await new Promise((resolve) => setTimeout(resolve, 100));
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'older here');
});

test('recalls prompts from a custom session folder with up', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'pi-statusline-sessions-'));
  writeSession('/work/custom', ['custom prompt'], undefined, sessionDir);
  writeSession('/work/custom', ['default prompt']);
  const { editor } = await startEditor('/work/custom', undefined, sessionDir);
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'custom prompt');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'custom prompt');
});

test('searches all folders in a custom session folder', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'pi-statusline-sessions-'));
  writeSession('/work/custom-all-b', ['custom elsewhere'], undefined, sessionDir);
  writeSession('/work/custom-all-c', ['default elsewhere']);
  const { editor, getSearch, editorTextSet } = await startEditor(
    '/work/custom-all-a',
    undefined,
    sessionDir,
  );
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  await allFoldersLoaded(search);
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'custom elsewhere');
});

test('puts a prompt sent later in a parallel session above one sent earlier here in all-folder reverse search', async () => {
  const { editor, getSearch, editorTextSet } = await startEditor('/work/later-a');
  send(editor, 'sent here');
  writeSession('/work/later-a', ['sent here'], [new Date().toISOString()]);
  writeSession(
    '/work/later-b',
    ['sent later elsewhere'],
    [new Date(Date.now() + 60_000).toISOString()],
  );
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  await allFoldersLoaded(search);
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'sent later elsewhere');
});

function userEntry(text: string) {
  return { type: 'message', message: { role: 'user', content: text } };
}

function assistantEntry(text: string) {
  return {
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function predicting(text: string, requests: unknown[] = []): Complete {
  return async (_model, context) => {
    requests.push(context);
    return { content: [{ type: 'text', text }], stopReason: 'stop' };
  };
}

async function settle(handlers: Map<string, Handler>, ctx: unknown, aborted = false) {
  await handlers.get('agent_settled')?.({ type: 'agent_settled', aborted }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
}

test('shows the predicted next prompt dimmed in the empty editor with the cursor on its first character', async () => {
  const requests: unknown[] = [];
  const { editor, handlers, ctx } = await startEditor('/work/predict-show', undefined, undefined, {
    branch: [userEntry('add a test'), assistantEntry('Added the test.')],
    complete: predicting('run the tests', requests),
  });
  await settle(handlers, ctx);
  const line = editor.render(80)[1] ?? '';
  assert.ok(line.includes(renderFakeCursor(themed('dim', 'r')) + themed('dim', 'un the tests')));
  assert.equal(visibleWidth(line), 80);
  assert.equal(editor.getText(), '');
  const request = JSON.stringify(requests[0]);
  assert.match(request, /add a test/);
  assert.match(request, /Added the test\./);
});

test('sends only the last five user prompts with the prediction request', async () => {
  const requests: unknown[] = [];
  const { handlers, ctx } = await startEditor('/work/predict-recent', undefined, undefined, {
    branch: ['one', 'two', 'three', 'four', 'five', 'six'].map(userEntry),
    complete: predicting('seven', requests),
  });
  await settle(handlers, ctx);
  const request = JSON.stringify(requests[0]);
  assert.doesNotMatch(request, /- one/);
  assert.match(request, /- two/);
  assert.match(request, /six/);
});

test('accepts the predicted prompt with tab and submits it with enter', async () => {
  const { editor, handlers, ctx, submitted } = await startEditor(
    '/work/predict-accept',
    undefined,
    undefined,
    { complete: predicting('run the tests') },
  );
  await settle(handlers, ctx);
  editor.handleInput('\t');
  assert.equal(editor.getText(), 'run the tests');
  editor.handleInput('\r');
  assert.deepEqual(submitted, ['run the tests']);
});

test('cuts long prompts and keeps the end of a long reply in the prediction request', async () => {
  const requests: unknown[] = [];
  const { handlers, ctx } = await startEditor('/work/predict-long', undefined, undefined, {
    branch: [userEntry(`${'p'.repeat(500)}CUT`), assistantEntry(`OLD${'r'.repeat(2000)}`)],
    complete: predicting('run the tests', requests),
  });
  await settle(handlers, ctx);
  const request = JSON.stringify(requests[0]);
  assert.match(request, new RegExp(`- ${'p'.repeat(500)}\\\\n`));
  assert.doesNotMatch(request, /CUT/);
  assert.match(request, new RegExp(`${'r'.repeat(2000)}"`));
  assert.doesNotMatch(request, /OLD/);
});

test('dismisses the predicted prompt when typing', async () => {
  const { editor, handlers, ctx } = await startEditor(
    '/work/predict-dismiss',
    undefined,
    undefined,
    {
      complete: predicting('run the tests'),
    },
  );
  await settle(handlers, ctx);
  editor.handleInput('x');
  assert.ok(!editor.render(80).some((line) => line.includes('run the tests')));
  editor.handleInput('\x7f');
  editor.handleInput('\t');
  assert.notEqual(editor.getText(), 'run the tests');
});

test('drops a prediction that arrives after typing starts', async () => {
  let finish: (value: unknown) => void = () => {};
  let signal: AbortSignal | undefined;
  const { editor, handlers, ctx } = await startEditor('/work/predict-late', undefined, undefined, {
    complete: (_model, _context, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const settled = settle(handlers, ctx);
  editor.handleInput('x');
  assert.equal(signal?.aborted, true);
  finish({ content: [{ type: 'text', text: 'run the tests' }], stopReason: 'aborted' });
  await settled;
  assert.ok(!editor.render(80).some((line) => line.includes('run the tests')));
});

test('does not predict after an aborted run', async () => {
  const requests: unknown[] = [];
  const { handlers, ctx } = await startEditor('/work/predict-aborted', undefined, undefined, {
    complete: predicting('run the tests', requests),
  });
  await settle(handlers, ctx, true);
  assert.equal(requests.length, 0);
});

test('cancels a running prediction when a new session starts', async () => {
  let signal: AbortSignal | undefined;
  const { handlers, ctx } = await startEditor('/work/predict-switch', undefined, undefined, {
    complete: (_model, _context, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  await settle(handlers, ctx);
  await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
  assert.equal(signal?.aborted, true);
});

test('turns prediction off and on with /predict and remembers it', async () => {
  const requests: unknown[] = [];
  const first = await startEditor('/work/predict-toggle', undefined, undefined, {
    complete: predicting('run the tests', requests),
  });
  await first.commands.get('predict')?.handler('', first.ctx);
  assert.deepEqual(first.notifications, ['Prompt prediction off']);
  await settle(first.handlers, first.ctx);
  assert.equal(requests.length, 0);

  const second = await startEditor('/work/predict-toggle', undefined, undefined, {
    complete: predicting('run the tests', requests),
  });
  await settle(second.handlers, second.ctx);
  assert.equal(requests.length, 0);
  await second.commands.get('predict')?.handler('', second.ctx);
  assert.deepEqual(second.notifications, ['Prompt prediction on']);
  await settle(second.handlers, second.ctx);
  assert.equal(requests.length, 1);
});

test('keeps prediction on when the settings file is not an object', async () => {
  const settingsFile = join(agentDir, 'pi-statusline.json');
  writeFileSync(settingsFile, 'null\n');
  try {
    const requests: unknown[] = [];
    const { handlers, ctx } = await startEditor('/work/predict-null', undefined, undefined, {
      complete: predicting('run the tests', requests),
    });
    await settle(handlers, ctx);
    assert.equal(requests.length, 1);
  } finally {
    rmSync(settingsFile, { force: true });
  }
});

test('turns prediction off with /predict and warns when the setting cannot be saved', async () => {
  const settingsFile = join(agentDir, 'pi-statusline.json');
  mkdirSync(settingsFile);
  try {
    const requests: unknown[] = [];
    const { commands, handlers, ctx, notifications } = await startEditor(
      '/work/predict-unsaved',
      undefined,
      undefined,
      { complete: predicting('run the tests', requests) },
    );
    await commands.get('predict')?.handler('', ctx);
    assert.deepEqual(notifications, ['Prompt prediction off, but the setting could not be saved']);
    await settle(handlers, ctx);
    assert.equal(requests.length, 0);
  } finally {
    rmSync(settingsFile, { recursive: true, force: true });
  }
});

test('does not hold up the agent while predicting', async () => {
  const { handlers, ctx } = await startEditor('/work/predict-background', undefined, undefined, {
    complete: () => new Promise(() => {}),
  });
  const result = await Promise.race([
    Promise.resolve(
      handlers.get('agent_settled')?.({ type: 'agent_settled', aborted: false }, ctx),
    ).then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 50)),
  ]);
  assert.equal(result, 'settled');
});
