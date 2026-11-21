import { useState, type FormEvent } from "react";
import { ArrowLeft, GitFork, HardDrive, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusPanel } from "@/components/brand";
import { ConfirmButton, CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { RepoBrowser } from "@/components/repo-browser";
import { api, formatTime, useApi, type RepoCommit, type RepoRecord } from "@/lib/api";
import { Link, navigate } from "@/lib/router";

function NameDialog({
  title,
  action,
  onClose,
  onSubmit,
}: {
  title: string;
  action: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="repo-name">Name (optional)</Label>
            <Input id="repo-name" value={name} onChange={event => setName(event.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{action}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReposPage() {
  const reposRes = useApi<{ repos: RepoRecord[] }>("/v2/repos");
  const [creating, setCreating] = useState(false);
  const repos = reposRes.data?.repos;

  return (
    <>
      <PageHeader
        title="Repositories"
        docs="files"
        description="Git-backed CamelFS workspaces. Agents mount a repository at /workspace with instant forks and commit history."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New repository</Button>}
      />
      <ErrorAlert error={reposRes.error} />
      {reposRes.loading && !repos ? (
        <Skeleton className="h-40 w-full" />
      ) : repos?.length === 0 ? (
        <EmptyState
          icon={<HardDrive />}
          title="No repositories yet"
          action={<Button size="sm" onClick={() => setCreating(true)}><Plus />New repository</Button>}
        >
          A CamelFS repository gives agents persistent versioned storage and copy-on-write forks. Create one here or attach one when creating an agent.
        </EmptyState>
      ) : repos && (
        <div className="bg-card border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">ID</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="hidden md:table-cell">Commit</TableHead>
                <TableHead className="hidden lg:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.map(repo => (
                <TableRow key={repo.repoId} className="cursor-pointer" onClick={() => navigate(`repos/${repo.repoId}`)}>
                  <TableCell className="font-medium">
                    <Link to={`repos/${repo.repoId}`}>{repo.name || repo.repoId}</Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">{repo.repoId}</TableCell>
                  <TableCell><Badge variant="outline">{repo.defaultRef}</Badge></TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                    {repo.commit ? repo.commit.slice(0, 10) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">{formatTime(repo.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {creating && (
        <NameDialog
          title="New repository"
          action="Create"
          onClose={() => setCreating(false)}
          onSubmit={async name => {
            const created = await api<RepoRecord>("/v2/repos", { method: "POST", body: name ? { name } : {} });
            navigate(`repos/${created.repoId}`);
          }}
        />
      )}
    </>
  );
}

export function RepoPage({ id }: { id: string }) {
  const repo = useApi<RepoRecord>(`/v2/repos/${encodeURIComponent(id)}`);
  const history = useApi<{ commits: RepoCommit[] }>(`/v2/repos/${encodeURIComponent(id)}/history?limit=30`);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string>();
  const [browserEpoch, setBrowserEpoch] = useState(0);

  if (repo.error?.status === 404) {
    return (
      <StatusPanel
        code="404"
        label="Not found"
        detail="This repository does not exist or belongs to another tenant."
        action={<Button variant="outline" asChild><Link to="repos"><ArrowLeft />Repositories</Link></Button>}
      />
    );
  }
  if (!repo.data) return <><ErrorAlert error={repo.error} /><Skeleton className="h-64 w-full" /></>;

  const data = repo.data;
  const commits = history.data?.commits ?? [];

  return (
    <>
      <Link to="repos" className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" />Repositories
      </Link>
      <PageHeader
        title={data.name || id}
        description={
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs">{id}</span>
            <CopyButton value={id} label="Copy repository ID" />
            <span>· {data.defaultRef} · created {formatTime(data.createdAt)}</span>
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setForking(true)}><GitFork />Fork</Button>
            <ConfirmButton
              label="Delete"
              icon={<Trash2 />}
              variant="destructive"
              title={`Delete ${data.name || id}?`}
              description="Deletes this repository lineage and all its commits. Agents referencing it will no longer be able to read or write files."
              confirm="Delete repository"
              onConfirm={async () => {
                try {
                  await api(`/v2/repos/${encodeURIComponent(id)}`, { method: "DELETE" });
                  navigate("repos");
                } catch (caught) {
                  setError((caught as Error).message);
                }
              }}
            />
          </>
        }
      />
      <ErrorAlert error={error} />
      <div className="flex flex-col gap-4">
        <RepoBrowser
          key={`${id}:${browserEpoch}`}
          repoId={id}
          refName={data.defaultRef}
          onChange={() => {
            void repo.reload();
            void history.reload();
          }}
        />
        <Card>
          <CardHeader><CardTitle>Commit history</CardTitle></CardHeader>
          <CardContent>
            <ErrorAlert error={history.error} />
            {commits.length === 0 ? (
              <p className="text-muted-foreground text-sm">No commits recorded yet.</p>
            ) : (
              <div className="bg-card border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Commit</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="hidden sm:table-cell">Author</TableHead>
                      <TableHead className="hidden md:table-cell">Time</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commits.map((c, index) => (
                      <TableRow key={c.commit}>
                        <TableCell className="font-mono text-xs">{c.commit.slice(0, 10)}</TableCell>
                        <TableCell className="text-sm">{c.message || "(no message)"}</TableCell>
                        <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">{c.author || "—"}</TableCell>
                        <TableCell className="text-muted-foreground hidden text-xs md:table-cell">{formatTime(c.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          {index > 0 && (
                            <ConfirmButton
                              size="xs"
                              variant="outline"
                              label="Restore"
                              icon={<RotateCcw />}
                              title={`Restore to ${c.commit.slice(0, 10)}?`}
                              description="Creates a new commit on the branch matching the tree from this commit."
                              confirm="Restore"
                              onConfirm={async () => {
                                try {
                                  await api(`/v2/repos/${encodeURIComponent(id)}/restore`, {
                                    method: "POST",
                                    body: { targetCommit: c.commit, message: `Restore ${c.commit.slice(0, 10)}` },
                                  });
                                  await Promise.all([repo.reload(), history.reload()]);
                                  setBrowserEpoch(n => n + 1);
                                } catch (caught) {
                                  setError((caught as Error).message);
                                }
                              }}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {forking && (
        <NameDialog
          title={`Fork ${data.name || id}`}
          action="Fork"
          onClose={() => setForking(false)}
          onSubmit={async name => {
            const forked = await api<RepoRecord>(`/v2/repos/${encodeURIComponent(id)}/fork`, {
              method: "POST",
              body: name ? { name } : {},
            });
            navigate(`repos/${forked.repoId}`);
          }}
        />
      )}
    </>
  );
}
