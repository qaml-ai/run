import type { Entry } from './repo-policy.ts';
import type { ListOptions } from './storage.ts';

const maxTrees = 4;
const maxEntries = 200_000;
type Head = { version: string; tree: string };

export function workspaceRefKey(lineage: string, ref: string) {
  return JSON.stringify([lineage, ref]);
}

export class RepoTreeCache {
  private readonly pins = new Map<string, number>();
  private readonly sql: SqlStorage;

  private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

  constructor(storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS repo_tree_entries (
        tree TEXT, path TEXT, blob TEXT, mode TEXT, size INTEGER, PRIMARY KEY (tree, path)
      );
      CREATE TABLE IF NOT EXISTS repo_trees (
        tree TEXT PRIMARY KEY, complete INTEGER NOT NULL, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS repo_tree_heads (
        ref TEXT PRIMARY KEY, version TEXT NOT NULL, tree TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_tree_oversize (tree TEXT PRIMARY KEY);
    `);
    this.storage.transactionSync(() => this.prune());
  }

  scope() {
    const held = new Set<string>();
    return {
      cache: this,
      pin: (tree: string) => {
        if (held.has(tree)) return;
        held.add(tree);
        this.hold(tree);
      },
      close: () => {
        if (!held.size) return;
        for (const tree of held) this.release(tree);
        held.clear();
        this.storage.transactionSync(() => this.prune());
      },
    };
  }

  private hold(tree: string) {
    this.pins.set(tree, (this.pins.get(tree) ?? 0) + 1);
  }

  private release(tree: string) {
    const count = this.pins.get(tree)!;
    if (count === 1) this.pins.delete(tree);
    else this.pins.set(tree, count - 1);
  }

  async write<T extends { previous: string | null; version: string | null; tree: string | null; files: Record<string, Entry | null> }>(
    ref: string, commit: () => Promise<T>,
  ): Promise<T> {
    const base = this.head(ref);
    if (base) this.hold(base.tree);
    let result: T;
    try {
      result = await commit();
    } catch (error) {
      if (base) {
        this.release(base.tree);
        this.storage.transactionSync(() => this.prune());
      }
      throw error;
    }
    if (base) this.release(base.tree);
    if (result.version && result.tree) {
      this.ownWrite(ref, base, result.previous, { version: result.version, tree: result.tree }, result.files);
    } else {
      this.storage.transactionSync(() => this.prune());
    }
    return result;
  }

  retainHeads(refs: string[]) {
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM repo_tree_heads WHERE ref NOT IN (SELECT value FROM json_each(?))', JSON.stringify(refs));
      this.prune();
    });
  }

  head(ref: string) {
    return this.sql.exec<Head>('SELECT version, tree FROM repo_tree_heads WHERE ref = ?', ref).toArray()[0];
  }

  private setHead(ref: string, head: Head | null) {
    if (head) this.sql.exec('INSERT OR REPLACE INTO repo_tree_heads VALUES (?, ?, ?)', ref, head.version, head.tree);
    else this.sql.exec('DELETE FROM repo_tree_heads WHERE ref = ?', ref);
  }

  observe(ref: string, head: Head | null) {
    if ((this.head(ref)?.version ?? null) === (head?.version ?? null)) return;
    this.storage.transactionSync(() => {
      this.setHead(ref, head);
      this.prune();
    });
  }

  notify(ref: string, from: string | null, to: Head) {
    const head = this.head(ref);
    if (!head || head.version === to.version) return;
    // A gap may be an out-of-order delivery. Let the next ref read establish the head.
    this.observe(ref, head.version === from ? to : null);
  }

  oversize(tree: string) {
    return !!this.sql.exec('SELECT 1 FROM repo_tree_oversize WHERE tree = ?', tree).toArray().length;
  }

  complete(tree: string) {
    return !!this.sql.exec('SELECT 1 FROM repo_trees WHERE tree = ? AND complete = 1', tree).toArray().length;
  }

  entries(tree: string): Entry[] | undefined {
    if (this.complete(tree))
      return this.sql.exec<Entry>('SELECT path, blob, mode, size FROM repo_tree_entries WHERE tree = ? ORDER BY path', tree).toArray();
  }

  stat(tree: string, paths: string[]) {
    if (!this.complete(tree)) return;
    return Object.fromEntries(paths.map(path => [path, this.sql.exec<Entry>(
      'SELECT path, blob, mode, size FROM repo_tree_entries WHERE tree = ? AND path = ?', tree, path,
    ).toArray()[0] ?? null]));
  }

  list(tree: string, { path, after, limit = 10000 }: ListOptions) {
    if (!this.complete(tree)) return;
    const prefix = path ? path + '/' : '';
    const entries = this.sql.exec<Entry>(`
      SELECT path, blob, mode, size FROM repo_tree_entries
      WHERE tree = ? AND path > ? ${prefix ? 'AND path >= ? AND path < ?' : ''}
      ORDER BY path LIMIT ?
    `, tree, after ?? '', ...(prefix ? [prefix, path + '0'] : []), limit + 1).toArray();
    return { entries: entries.slice(0, limit), next: entries.length > limit ? entries[limit - 1].path : null };
  }

  fill(tree: string, entries: Entry[]) {
    this.storage.transactionSync(() => {
      if (this.complete(tree)) return;
      this.prune();
      if (!this.canFit(tree, entries.length)) return;
      this.drop(tree);
      // Keep each JSON binding small even for long paths.
      for (let start = 0; start < entries.length; start += 100) {
        this.sql.exec(`
          INSERT INTO repo_tree_entries
          SELECT ?, json_extract(value, '$.path'), json_extract(value, '$.blob'),
            json_extract(value, '$.mode'), json_extract(value, '$.size') FROM json_each(?)
        `, tree, JSON.stringify(entries.slice(start, start + 100)));
      }
      this.markComplete(tree);
    });
  }

  ownWrite(ref: string, base: Head | undefined, previous: string | null, head: Head, changes: Record<string, Entry | null>) {
    this.storage.transactionSync(() => {
      const current = this.head(ref);
      if (!current || current.version === base?.version || current.version === previous) this.setHead(ref, head);
      if (current?.version === previous) base = current;
      if (base && base.version === previous && this.complete(base.tree) && !this.complete(head.tree) && this.live(head.tree)) {
        const source = base.tree;
        const count = this.count(source) + Object.entries(changes).reduce((delta, [path, entry]) => {
          const existed = !!this.sql.exec('SELECT 1 FROM repo_tree_entries WHERE tree = ? AND path = ?', source, path).toArray().length;
          return delta + Number(entry !== null) - Number(existed);
        }, 0);
        // Exclude the source from the budget if this move makes it unreachable.
        this.prune(source);
        if (this.canFit(head.tree, count, source)) {
          this.drop(head.tree);
          this.sql.exec('INSERT INTO repo_tree_entries SELECT ?, path, blob, mode, size FROM repo_tree_entries WHERE tree = ?', head.tree, source);
          for (const [path, entry] of Object.entries(changes)) {
            if (entry) this.sql.exec('INSERT OR REPLACE INTO repo_tree_entries VALUES (?, ?, ?, ?, ?)', head.tree, path, entry.blob, entry.mode, entry.size);
            else this.sql.exec('DELETE FROM repo_tree_entries WHERE tree = ? AND path = ?', head.tree, path);
          }
          this.markComplete(head.tree);
        }
      }
      this.prune();
    });
  }

  private count(tree: string) {
    return this.sql.exec<{ count: number }>('SELECT count(*) AS count FROM repo_tree_entries WHERE tree = ?', tree).one().count;
  }

  private live(tree: string) {
    return this.pins.has(tree) || !!this.sql.exec('SELECT 1 FROM repo_tree_heads WHERE tree = ? LIMIT 1', tree).toArray().length;
  }

  private canFit(tree: string, count: number, source?: string) {
    if (count > maxEntries) {
      if (this.sql.exec('INSERT OR IGNORE INTO repo_tree_oversize VALUES (?) RETURNING tree', tree).toArray().length)
        console.warn('Repo tree exceeds agent cache entry limit', { tree, entries: count });
      return false;
    }
    if (!this.live(tree)) return false;
    const retained = this.sql.exec<{ tree: string }>('SELECT tree FROM repo_trees WHERE complete = 1').toArray()
      .filter(row => row.tree !== source || this.live(row.tree));
    // Every retained tree is live. Leave the incoming tree uncached if they fill the budget.
    return retained.length < maxTrees && count + retained.reduce((sum, row) => sum + this.count(row.tree), 0) <= maxEntries;
  }

  private markComplete(tree: string) {
    this.sql.exec('INSERT INTO repo_trees VALUES (?, 1, ?)', tree, Date.now());
  }

  private drop(tree: string) {
    this.sql.exec('DELETE FROM repo_tree_entries WHERE tree = ?', tree);
    this.sql.exec('DELETE FROM repo_trees WHERE tree = ?', tree);
  }

  private prune(except?: string) {
    const trees = this.sql.exec<{ tree: string; complete: number }>('SELECT tree, complete FROM repo_trees ORDER BY created_at, tree').toArray();
    for (const { tree, complete } of trees)
      if (tree !== except && (!complete || !this.live(tree))) this.drop(tree);
  }
}

export type RepoTreeScope = ReturnType<RepoTreeCache['scope']>;
