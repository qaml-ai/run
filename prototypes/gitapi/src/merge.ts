// Three-way merge of two trees over a common base, by path then by line. The decision per path is git's: a side
// that did not touch the path yields to the one that did; both touching it the same way agree; both touching it
// differently is settled by diff3 on lines when the file is text, and is a conflict otherwise. There is no
// rename detection: a rename is a delete plus an add, as in a merge without `-M`.

export type TreeIndex = Map<string, string>; // path -> blob sha

export type MergeDecision =
  | { path: string; kind: "take"; sha: string | null } // null: the path is removed
  | { path: string; kind: "lines"; base?: string; ours: string; theirs: string } // needs the three blobs
  ;

/** Which paths changed between the base and each side, and what the merged tree takes without looking at content. */
export function planMerge(base: TreeIndex, ours: TreeIndex, theirs: TreeIndex): { decisions: MergeDecision[] } {
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const decisions: MergeDecision[] = [];
  for (const path of paths) {
    const b = base.get(path) ?? null, o = ours.get(path) ?? null, t = theirs.get(path) ?? null;
    const oursChanged = o !== b, theirsChanged = t !== b;
    if (!theirsChanged) continue; // ours already holds it (or neither changed it)
    if (!oursChanged) { decisions.push({ path, kind: "take", sha: t }); continue; }
    if (o === t) continue; // both made the same change
    if (o === null || t === null) { decisions.push({ path, kind: "lines", base: b ?? undefined, ours: o ?? "", theirs: t ?? "" }); continue; }
    decisions.push({ path, kind: "lines", base: b ?? undefined, ours: o, theirs: t });
  }
  return { decisions };
}

export type LineMerge = { ok: true; text: string } | { ok: false; conflicts: number };

/**
 * diff3 on lines: hunks where only one side differs from the base take that side; hunks where both differ identically
 * agree; hunks where both differ differently conflict. The alignment is the classic one: common subsequences of base
 * with each side (LCS), then a walk that groups changed regions.
 */
export function mergeLines(base: string, ours: string, theirs: string): LineMerge {
  const b = splitLines(base), o = splitLines(ours), t = splitLines(theirs);
  const mo = matches(b, o), mt = matches(b, t);
  const out: string[] = [];
  let conflicts = 0;
  let bi = 0, oi = 0, ti = 0;
  while (bi < b.length || oi < o.length || ti < t.length) {
    // A stable point: both sides match the base here.
    if (bi < b.length && mo.get(bi) === oi && mt.get(bi) === ti) { out.push(b[bi]); bi++; oi++; ti++; continue; }
    // Otherwise a changed region: extend until the next base line matched by BOTH sides.
    let nb = bi;
    while (nb < b.length && !(mo.has(nb) && mt.has(nb))) nb++;
    const no = nb < b.length ? mo.get(nb)! : o.length, nt = nb < b.length ? mt.get(nb)! : t.length;
    const baseHunk = b.slice(bi, nb), ourHunk = o.slice(oi, no), theirHunk = t.slice(ti, nt);
    const oursSame = equal(baseHunk, ourHunk), theirsSame = equal(baseHunk, theirHunk);
    if (oursSame) out.push(...theirHunk);
    else if (theirsSame || equal(ourHunk, theirHunk)) out.push(...ourHunk);
    else { conflicts++; out.push("<<<<<<< ours", ...ourHunk, "=======", ...theirHunk, ">>>>>>> theirs"); }
    bi = nb; oi = no; ti = nt;
  }
  if (conflicts) return { ok: false, conflicts };
  return { ok: true, text: out.join("\n") + (base.endsWith("\n") || ours.endsWith("\n") || theirs.endsWith("\n") ? "\n" : "") };
}

function splitLines(text: string) { const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop(); return lines; }
const equal = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** base index -> side index for the lines of a longest common subsequence. */
function matches(a: string[], b: string[]): Map<number, number> {
  const n = a.length, m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const map = new Map<number, number>();
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { map.set(i, j); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return map;
}
