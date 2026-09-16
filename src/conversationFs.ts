/**
 * The SDK conversation store, over Obsidian's vault adapter.
 *
 * The only interesting decision is the root: files live under this plugin's own
 * folder (`manifest.dir`), not in the vault's note tree, so indexing and the
 * file explorer never see a conversation as a note and deleting the plugin
 * cannot delete a user's notes. The path is vault-relative because that is what
 * `DataAdapter` speaks.
 *
 * The store's contract is documented on `AiStoreFs`: `rename` must replace, and
 * `readText` returns null for a missing file. Both are wrapped here rather than
 * assumed, because a missing conversation is a normal state and an exception
 * from `adapter.read` would otherwise turn it into a crash.
 */

import { normalizePath, type DataAdapter } from "obsidian";
import type { AiStoreFs } from "../sdk/src/ai/aiConversationStore";

export function createVaultConversationFs(adapter: DataAdapter, root: string): AiStoreFs {
  const prefix = (path: string): string => normalizePath(root ? `${root}/${path}` : path);
  return {
    async mkdir(path) {
      try {
        await adapter.mkdir(prefix(path));
      } catch {
        // "already exists" is success for this contract.
      }
    },
    async readText(path) {
      try {
        return await adapter.read(prefix(path));
      } catch {
        return null;
      }
    },
    async writeText(path, text) {
      await adapter.write(prefix(path), text);
    },
    async rename(from, to) {
      const source = prefix(from);
      const target = prefix(to);
      try {
        await adapter.rename(source, target);
      } catch (error) {
        // Obsidian's vault adapter refuses to overwrite an existing destination
        // ("Destination file already exists!"), and every store rewrite -- the
        // index after each save, a record after each message -- needs exactly
        // that. Removing the destination first is the documented way around it;
        // if the source is gone this was a real failure and is rethrown.
        if (!(await adapter.exists(source))) throw error;
        await adapter.remove(target).catch(() => undefined);
        await adapter.rename(source, target);
      }
    },
    async remove(path) {
      try {
        await adapter.remove(prefix(path));
      } catch {
        // Removing a file that is already gone is not a failure.
      }
    },
    async list(dir) {
      try {
        const listing = await adapter.list(prefix(dir));
        return listing.files.map((path) => path.slice(path.lastIndexOf("/") + 1));
      } catch {
        return [];
      }
    },
  };
}