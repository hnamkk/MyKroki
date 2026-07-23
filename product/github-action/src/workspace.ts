import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveWithinRoot } from "./core.js";

export interface WorkspaceMutation {
  outputPath: string;
  content?: Buffer;
}

export function applyWorkspaceTransaction(root: string, mutations: WorkspaceMutation[]): void {
  const snapshots = new Map<string, Buffer | undefined>();
  const staged = new Map<string, string>();
  try {
    for (const mutation of mutations) {
      const target = resolveWithinRoot(root, mutation.outputPath);
      snapshots.set(target, existsSync(target) ? readFileSync(target) : undefined);
      if (mutation.content) {
        mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.diagram-${randomUUID()}.tmp`;
        writeFileSync(temporary, mutation.content, { flag: "wx" });
        staged.set(target, temporary);
      }
    }

    for (const mutation of mutations) {
      const target = resolveWithinRoot(root, mutation.outputPath);
      const temporary = staged.get(target);
      if (temporary) renameSync(temporary, target);
      else if (existsSync(target)) unlinkSync(target);
    }
  } catch (error) {
    for (const [target, snapshot] of snapshots) {
      try {
        if (snapshot) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, snapshot);
        } else if (existsSync(target)) {
          unlinkSync(target);
        }
      } catch {
        // Preserve the original transaction error; rollback is best effort.
      }
    }
    throw error;
  } finally {
    for (const temporary of staged.values()) {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
}
