import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent';

export type HistoryScope = 'current' | 'all';

const HISTORY_LIMIT = 500;
const PARALLEL_READS = 32;

type RawEntry = {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; command?: unknown; excludeFromContext?: unknown };
};

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function isRecallablePrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !isSkillBlock(trimmed);
}

function promptText(message: NonNullable<RawEntry['message']>): string {
  if (message.role === 'user') return extractText(message.content);
  if (message.role === 'bashExecution' && typeof message.command === 'string') {
    return `${message.excludeFromContext === true ? '!!' : '!'}${message.command}`;
  }
  return '';
}

export function isSkillBlock(text: string): boolean {
  return text.trim().startsWith('<skill name="');
}

export type TimedPrompt = { text: string; time: number };

async function readPrompts(filePath: string, fallbackTime: number): Promise<TimedPrompt[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  const prompts: TimedPrompt[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"role":"user"') && !line.includes('"role":"bashExecution"')) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const text = promptText(entry.message);
    const time = Date.parse(entry.timestamp ?? '');
    if (isRecallablePrompt(text)) {
      prompts.push({ text: text.trim(), time: Number.isNaN(time) ? fallbackTime : time });
    }
  }
  return prompts;
}

export function uniqueNewest(prompts: string[], limit = Infinity): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (const prompt of [...prompts].reverse()) {
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    newestFirst.push(prompt);
    if (newestFirst.length >= limit) break;
  }
  return newestFirst.reverse();
}

function listAllSessions(sessionDir: string) {
  const usesDefault = resolve(dirname(sessionDir)) === resolve(join(getAgentDir(), 'sessions'));
  return usesDefault ? SessionManager.listAll() : SessionManager.listAll(sessionDir);
}

export async function loadPromptHistory(
  cwd: string,
  sessionDir: string,
  scope: HistoryScope,
  extra: TimedPrompt[] = [],
): Promise<string[]> {
  let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
  try {
    sessions =
      scope === 'all'
        ? await listAllSessions(sessionDir)
        : await SessionManager.list(cwd, sessionDir);
  } catch {
    return [];
  }
  const ordered = [...sessions].sort((a, b) => a.modified.getTime() - b.modified.getTime());
  const timed: TimedPrompt[] = [...extra];
  for (let start = 0; start < ordered.length; start += PARALLEL_READS) {
    const batch = ordered.slice(start, start + PARALLEL_READS);
    const results = await Promise.all(
      batch.map((session) => readPrompts(session.path, session.modified.getTime())),
    );
    for (const prompts of results) timed.push(...prompts);
  }
  const all = timed.sort((a, b) => a.time - b.time).map((prompt) => prompt.text);
  return uniqueNewest(all, HISTORY_LIMIT);
}
