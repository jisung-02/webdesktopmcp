/**
 * App registry — how `webdesktopmcp connect` (and other local tools) discover
 * running desktop apps. Every host implementation (TS/Rust/Go) writes the
 * same file so one CLI works with all frameworks.
 *
 * Path: `~/.webdesktopmcp/registry.json`, written atomically, mode 0600
 * (the file contains the endpoint bearer token).
 */

import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION, type AppRegistry, type AppRegistryEntry } from "@webdesktopmcp/protocol";

export function registryFilePath(baseDir?: string): string {
  return path.join(baseDir ?? path.join(homedir(), ".webdesktopmcp"), "registry.json");
}

async function readRegistry(file: string): Promise<AppRegistry> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as AppRegistry;
    return { apps: parsed.apps ?? {} };
  } catch {
    return { apps: {} };
  }
}

/** Insert or refresh this app's entry (call at server start). */
export async function upsertAppEntry(entry: Omit<AppRegistryEntry, "protocolVersion" | "updatedAt">, baseDir?: string): Promise<void> {
  const file = registryFilePath(baseDir);
  await mkdir(path.dirname(file), { recursive: true });
  const registry = await readRegistry(file);
  // Drop stale entries from dead processes of any app while we're here.
  registry.apps[entry.appName] = { ...entry, protocolVersion: PROTOCOL_VERSION, updatedAt: new Date().toISOString() };
  await writeAtomic(file, JSON.stringify(registry, null, 2));
}

/** Remove this app's entry (call on graceful shutdown). */
export async function removeAppEntry(appName: string, baseDir?: string): Promise<void> {
  const file = registryFilePath(baseDir);
  const registry = await readRegistry(file);
  if (!(appName in registry.apps)) return;
  delete registry.apps[appName];
  await writeAtomic(file, JSON.stringify(registry, null, 2));
}

export async function readAppEntry(appName: string, baseDir?: string): Promise<AppRegistryEntry | undefined> {
  const registry = await readRegistry(registryFilePath(baseDir));
  return registry.apps[appName];
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
