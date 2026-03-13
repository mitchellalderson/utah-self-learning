/**
 * Prompt Versioning — A/B testing and version management for SOUL.md
 *
 * Allows multiple versions of behavioral prompts to coexist,
 * with weighted random selection for experimentation.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { config } from "../config.ts";
import { logger } from "./logger.ts";

export interface PromptVersion {
  id: string;
  created: string;
  source: "baseline" | "evaluation-pipeline";
  active: boolean;
  weight: number;
  parentVersion?: string;
}

export interface PromptRegistry {
  versions: PromptVersion[];
  currentDefault: string;
}

export interface VersionSelection {
  versionId: string;
  soulContent: string;
}

function getPromptsDir(): string {
  return resolve(config.workspace.root, "prompts");
}

function getRegistryPath(): string {
  return resolve(getPromptsDir(), "registry.json");
}

function getVersionPath(versionId: string): string {
  return resolve(getPromptsDir(), versionId, "SOUL.md");
}

export async function loadRegistry(): Promise<PromptRegistry> {
  const path = getRegistryPath();
  try {
    const content = await readFile(path, "utf-8");
    const registry = JSON.parse(content) as PromptRegistry;

    if (!registry.versions || !Array.isArray(registry.versions)) {
      throw new Error("Invalid registry: missing versions array");
    }

    return registry;
  } catch (err) {
    logger.warn(
      { err },
      "[prompt-version] Registry not found or invalid, initializing fresh registry",
    );
    return await initPromptRegistry();
  }
}

export async function saveRegistry(registry: PromptRegistry): Promise<void> {
  const dir = getPromptsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(getRegistryPath(), JSON.stringify(registry, null, 2), "utf-8");
}

export function normalizeWeights(versions: PromptVersion[]): PromptVersion[] {
  const activeVersions = versions.filter((v) => v.active);
  const sum = activeVersions.reduce((acc, v) => acc + v.weight, 0);

  if (sum === 0) {
    logger.warn("[prompt-version] Weights sum to 0, using equal distribution");
    const equalWeight = 1 / activeVersions.length;
    return versions.map((v) => (v.active ? { ...v, weight: equalWeight } : v));
  }

  if (Math.abs(sum - 1.0) > 0.001) {
    logger.warn({ sum }, "[prompt-version] Weights don't sum to 1.0, normalizing");
    return versions.map((v) => (v.active ? { ...v, weight: v.weight / sum } : v));
  }

  return versions;
}

export function selectVersionByWeight(registry: PromptRegistry): PromptVersion {
  const normalizedVersions = normalizeWeights(registry.versions);
  const activeVersions = normalizedVersions.filter((v) => v.active);

  if (activeVersions.length === 0) {
    const defaultVersion = normalizedVersions.find((v) => v.id === registry.currentDefault);
    if (defaultVersion) {
      logger.warn("[prompt-version] No active versions, falling back to currentDefault");
      return defaultVersion;
    }
    throw new Error("No active versions and no valid currentDefault");
  }

  if (activeVersions.length === 1) {
    return activeVersions[0];
  }

  const random = Math.random();
  let cumulative = 0;

  for (const version of activeVersions) {
    cumulative += version.weight;
    if (random < cumulative) {
      return version;
    }
  }

  return activeVersions[activeVersions.length - 1];
}

export async function loadVersionedSoul(versionId: string): Promise<string | null> {
  const path = getVersionPath(versionId);
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

export async function initPromptRegistry(): Promise<PromptRegistry> {
  const dir = getPromptsDir();
  const v1Dir = resolve(dir, "v1");

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  if (!existsSync(v1Dir)) {
    await mkdir(v1Dir, { recursive: true });
  }

  const rootSoulPath = resolve(config.workspace.root, "SOUL.md");
  const v1SoulPath = getVersionPath("v1");

  let soulContent = "";
  if (existsSync(rootSoulPath)) {
    soulContent = await readFile(rootSoulPath, "utf-8");
    if (!existsSync(v1SoulPath)) {
      await writeFile(v1SoulPath, soulContent, "utf-8");
      logger.info("[prompt-version] Copied root SOUL.md to v1/SOUL.md");
    }
  } else {
    const defaultSoul = `# Soul

Be helpful, concise, and direct. Use tools when they add value.
Don't over-explain. Actions speak louder than words.`;
    await writeFile(v1SoulPath, defaultSoul, "utf-8");
    logger.info("[prompt-version] Created default v1/SOUL.md");
  }

  const registry: PromptRegistry = {
    versions: [
      {
        id: "v1",
        created: new Date().toISOString(),
        source: "baseline",
        active: true,
        weight: 1.0,
      },
    ],
    currentDefault: "v1",
  };

  await saveRegistry(registry);
  logger.info("[prompt-version] Initialized fresh registry with v1");

  return registry;
}

export async function selectPromptVersion(): Promise<VersionSelection> {
  const registry = await loadRegistry();
  const selectedVersion = selectVersionByWeight(registry);

  let soulContent = await loadVersionedSoul(selectedVersion.id);

  if (!soulContent) {
    const rootSoulPath = resolve(config.workspace.root, "SOUL.md");
    if (existsSync(rootSoulPath)) {
      soulContent = await readFile(rootSoulPath, "utf-8");
      logger.warn(
        { versionId: selectedVersion.id },
        "[prompt-version] Versioned SOUL.md not found, falling back to root SOUL.md",
      );
    } else {
      soulContent = "";
      logger.warn({ versionId: selectedVersion.id }, "[prompt-version] No SOUL.md found anywhere");
    }
  }

  logger.info(
    { versionId: selectedVersion.id, weight: selectedVersion.weight },
    "[prompt-version] Selected prompt version",
  );

  return {
    versionId: selectedVersion.id,
    soulContent,
  };
}
