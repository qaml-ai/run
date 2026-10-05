import { useState, type FormEvent } from "react";
import { ArrowLeft, Camera, HardDrive, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusPanel } from "@/components/brand";
import { ConfirmButton, CopyButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { FileBrowser } from "@/components/files";
import { api, formatBytes, formatTime, useApi, type Snapshot, type Volume, type VolumeSummary } from "@/lib/api";
import { Link, navigate } from "@/lib/router";

/** Asks for a name, then creates. */
function NameDialog({ title, action, onClose, onSubmit }: { title: string; action: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try { await onSubmit(name.trim()); onClose(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2"><Label htmlFor="name">Name (optional)</Label><Input id="name" value={name} onChange={event => setName(event.target.value)} autoFocus /></div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{action}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The list only has names, so each row reads its volume for the file count and size. */
function VolumeRow({ volume }: { volume: VolumeSummary }) {
  const info = useApi<Volume>(`/v1/volumes/${volume.id}`);
  return (
    <TableRow className="cursor-pointer" onClick={() => navigate(`volumes/${volume.id}`)}>
      <TableCell className="font-medium"><Link to={`volumes/${volume.id}`}>{volume.name || "(unnamed)"}</Link></TableCell>
      <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">{volume.id}</TableCell>
      <TableCell className="text-xs">{info.data ? info.data.files : "…"}</TableCell>
      <TableCell className="text-xs">{info.data ? formatBytes(info.data.bytes) : "…"}</TableCell>
      <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">{formatTime(volume.createdAt)}</TableCell>
    </TableRow>
  );
}

export function VolumesPage() {
  const volumes = useApi<VolumeSummary[]>("/v1/volumes");
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Volumes" docs="files"
        description="Durable file storage. Agents mount volumes (their workspace is one); attachments and files agents write live here."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New volume</Button>}
      />
      <ErrorAlert error={volumes.error} />
      {volumes.loading && !volumes.data ? <Skeleton className="h-40 w-full" />
        : volumes.data?.length === 0 ? <EmptyState icon={<HardDrive />} title="No volumes yet" action={<Button size="sm" onClick={() => setCreating(true)}><Plus />New volume</Button>}>A volume is durable file storage. Every agent gets a workspace volume when it is made; make one here to share files between agents.</EmptyState>
        : volumes.data && (
          <div className="bg-card border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Name</TableHead><TableHead className="hidden sm:table-cell">ID</TableHead><TableHead>Files</TableHead><TableHead>Size</TableHead><TableHead className="hidden lg:table-cell">Created</TableHead>
              </TableRow></TableHeader>
              <TableBody>{volumes.data.map(volume => <VolumeRow key={volume.id} volume={volume} />)}</TableBody>
            </Table>
          </div>
        )}
      {creating && <NameDialog title="New volume" action="Create" onClose={() => setCreating(false)}
        onSubmit={async name => { const volume = await api<Volume>("/v1/volumes", { body: name ? { name } : {} }); navigate(`volumes/${volume.id}`); }} />}
    </>
  );
}

export function VolumePage({ id }: { id: string }) {
  const volume = useApi<Volume>(`/v1/volumes/${id}`);
  const snapshots = useApi<Snapshot[]>(`/v1/volumes/${id}/snapshots`);
  const [snapshotting, setSnapshotting] = useState(false);
  const [error, setError] = useState<string>();
  if (volume.error?.status === 404) return <StatusPanel code="404" label="Not found" detail="This volume does not exist or belongs to another tenant."
    action={<Button variant="outline" asChild><Link to="volumes"><ArrowLeft />Volumes</Link></Button>} />;
  if (!volume.data) return <><ErrorAlert error={volume.error} /><Skeleton className="h-64 w-full" /></>;
  const data = volume.data;
  return (
    <>
      <Link to="volumes" className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"><ArrowLeft className="size-4" />Volumes</Link>
      <PageHeader
        title={data.name || "(unnamed volume)"}
        description={<span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-mono text-xs">{id}</span><CopyButton value={id} label="Copy volume ID" />
          <span>· {data.files} files · {formatBytes(data.bytes)} · created {formatTime(data.createdAt)}</span>
        </span>}
        actions={<>
          <Button size="sm" variant="outline" onClick={() => setSnapshotting(true)}><Camera />Snapshot</Button>
          <ConfirmButton label="Delete" icon={<Trash2 />} variant="destructive" title={`Delete ${data.name || id}?`} description="Its files and snapshots are deleted, and agents mounting it can no longer reach it. This cannot be undone." confirm="Delete volume"
            onConfirm={async () => { try { await api(`/v1/volumes/${id}`, { method: "DELETE" }); navigate("volumes"); } catch (caught) { setError((caught as Error).message); } }} />
        </>}
      />
      <ErrorAlert error={error} />
      <div className="flex flex-col gap-4">
        <FileBrowser volume={id} onChange={() => void volume.reload()} />
        <Card>
          <CardHeader><CardTitle>Snapshots</CardTitle></CardHeader>
          <CardContent>
            <ErrorAlert error={snapshots.error} />
            {!snapshots.data?.length ? <p className="text-muted-foreground text-sm">No snapshots. A snapshot copies the file list, sharing contents, so it is cheap.</p> : (
              <div className="bg-card border">
                <Table>
                  <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Files</TableHead><TableHead>Size</TableHead><TableHead className="hidden sm:table-cell">Seq</TableHead><TableHead>Created</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {snapshots.data.map(snapshot => (
                      <TableRow key={snapshot.id}>
                        <TableCell className="font-medium">{snapshot.name || <span className="text-muted-foreground font-mono text-xs">{snapshot.id}</span>}</TableCell>
                        <TableCell className="text-xs">{snapshot.files}</TableCell>
                        <TableCell className="text-xs">{formatBytes(snapshot.bytes)}</TableCell>
                        <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">{snapshot.seq}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{formatTime(snapshot.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          <ConfirmButton label="" icon={<Trash2 />} variant="ghost" size="xs" title="Delete this snapshot?" description="The volume's current files are not affected." confirm="Delete"
                            onConfirm={async () => { try { await api(`/v1/volumes/${id}/snapshots/${snapshot.id}`, { method: "DELETE" }); await snapshots.reload(); } catch (caught) { setError((caught as Error).message); } }} />
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
      {snapshotting && <NameDialog title="New snapshot" action="Snapshot" onClose={() => setSnapshotting(false)}
        onSubmit={async name => { await api(`/v1/volumes/${id}/snapshots`, { body: name ? { name } : {} }); await snapshots.reload(); }} />}
    </>
  );
}
