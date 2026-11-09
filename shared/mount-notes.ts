type Mount = { path: string; mode: string; instructions?: string };

/** Owner-supplied text stays below a label and cannot inject unindented prompt lines. */
export function mountNotes(mounts: readonly Mount[]): string {
  const notes = mounts.filter(mount => mount.instructions?.trim()).map(mount =>
    `  ${mount.path} (${mount.mode === "ro" ? "read-only" : "read-write"}): ${mount.instructions!.replace(/\s+/g, " ").trim()}`);
  return notes.length ? `Mount notes from the agent's owner:\n${notes.join("\n")}` : "";
}

export function mountNotesTooLong(mounts: readonly { instructions?: unknown }[]): boolean {
  return mounts.reduce((total, mount) => total + (typeof mount?.instructions === "string" ? mount.instructions.length : 0), 0) > 8192;
}
