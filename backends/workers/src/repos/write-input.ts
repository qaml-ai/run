import type { Entry, Mode } from "./repo-policy.ts";

export type RepoQuota = { limitBytes: number; otherBytes: number };
export type WriteChange = {
  path: string;
  expectBlob?: string;
} & ({ delete: true } | { text?: string; base64?: string; blob?: string; mode?: Mode });
export type MoveResult = { version: string; tree: string; bytes: number; files: number };
export type RepoWrite = {
  ref: string;
  expect?: string | null;
  changes: WriteChange[];
  author: string;
  message: string;
  time: number;
  trailers: Record<string, string>;
  quota?: RepoQuota;
  idempotencyKey?: string;
};
export type WriteResult = MoveResult & {
  parents: string[];
  time: number;
  changed: Record<string, Entry | null>;
  previous: string | null;
  moved: boolean;
};
