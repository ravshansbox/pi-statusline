import { readFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';

export type HistoryScope = 'current' | 'all';

const HISTORY_LIMIT = 500;

type RawEntry = {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
};

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

export function isRecallablePrompt(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('!') &&
    !isSkillBlock(trimmed)
  );
}

export function isSkillBlock(text: string): boolean {
  return text.trim().startsWith('<skill name="');
}

type TimedPrompt = { text: string; time: number };

async function readPrompts(filePath: string, fallbackTime: number): Promise<TimedPrompt[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  const prompts: TimedPrompt[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    const text = extractText(entry.message.content);
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

export async function loadPromptHistory(cwd: string, scope: HistoryScope): Promise<string[]> {
  let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
  try {
    sessions = scope === 'all' ? await SessionManager.listAll() : await SessionManager.list(cwd);
  } catch {
    return [];
  }
  const ordered = [...sessions].sort((a, b) => a.modified.getTime() - b.modified.getTime());
  const timed: TimedPrompt[] = [];
  for (const session of ordered) {
    timed.push(...(await readPrompts(session.path, session.modified.getTime())));
  }
  const all = timed.sort((a, b) => a.time - b.time).map((prompt) => prompt.text);
  return uniqueNewest(all, HISTORY_LIMIT);
}
