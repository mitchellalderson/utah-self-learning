/** Memory — MEMORY.md (curated long-term) + daily logs (append-only via "remember" tool). */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { config } from "../config.ts";

export const TIMESTAMP_PATTERN = /<!-- last_heartbeat: (.+) -->/;

export function parseLastHeartbeat(memoryContent: string): Date | null {
  const match = memoryContent.match(TIMESTAMP_PATTERN);
  if (!match) return null;
  const d = new Date(match[1]);
  return isNaN(d.getTime()) ? null : d;
}

export function stripTimestamp(content: string): string {
  return content.replace(/\n*<!-- last_heartbeat: .+ -->\s*$/, "").trimEnd();
}

export function appendTimestamp(content: string): string {
  const ts = new Date().toISOString();
  return `${content.trimEnd()}\n\n<!-- last_heartbeat: ${ts} -->`;
}

function getWorkspacePath(...parts: string[]): string {
  return resolve(config.workspace.root, ...parts);
}

function todayString(): string {
  return new Date().toISOString().split("T")[0];
}

export async function ensureWorkspace(): Promise<void> {
  const dirs = [
    config.workspace.root,
    getWorkspacePath(config.workspace.memoryDir),
    getWorkspacePath(config.workspace.sessionDir),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }
}

export async function readMemory(): Promise<string> {
  const path = getWorkspacePath(config.workspace.memoryFile);
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export async function writeMemory(content: string): Promise<void> {
  const path = getWorkspacePath(config.workspace.memoryFile);
  await writeFile(path, content, "utf-8");
}

export async function readDailyLog(date?: string): Promise<string> {
  const d = date || todayString();
  const path = getWorkspacePath(config.workspace.memoryDir, `${d}.md`);
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export async function appendDailyLog(entry: string): Promise<void> {
  const d = todayString();
  const path = getWorkspacePath(config.workspace.memoryDir, `${d}.md`);
  const existing = await readDailyLog(d);
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const content = existing
    ? `${existing}\n\n### ${timestamp}\n${entry}`
    : `# ${d}\n\n### ${timestamp}\n${entry}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

const MAX_MEMORY_CHARS = 10_000;

function truncateToFit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return "...(truncated)...\n" + text.slice(-maxChars);
}

export async function buildMemoryContext(): Promise<string> {
  const raw = await readMemory();
  const memory = stripTimestamp(raw).trim();
  const today = await readDailyLog();
  const yesterday = await readDailyLog(new Date(Date.now() - 86400000).toISOString().split("T")[0]);

  const parts: string[] = [];

  if (memory) {
    parts.push(`### Long-Term User Memory (MEMORY.md)\n${memory}`);
  }
  if (yesterday) {
    parts.push(`### Yesterday's Log\n${yesterday}`);
  }
  if (today) {
    parts.push(`### Today's Log\n${today}`);
  }

  if (parts.length === 0) {
    return "(No memory files found yet. Use the 'remember' tool to start building memory.)";
  }

  const full = parts.join("\n\n---\n\n");
  return truncateToFit(full, MAX_MEMORY_CHARS);
}
