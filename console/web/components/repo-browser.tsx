import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronRight, Download, Eye, File, FileText, Folder, Image, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton, ErrorAlert } from "@/components/common";
import { api, formatBytes, type RepoLsEntry, type RepoReadResult } from "@/lib/api";
import { cn } from "@/lib/utils";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const joinPath = (dir: string, name: string) => (dir ? `${dir.replace(/\/$/, "")}/${name}` : name);

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    ts: "text/typescript",
    tsx: "text/typescript",
    js: "text/javascript",
    py: "text/x-python",
    go: "text/x-go",
    css: "text/css",
    html: "text/html",
    yaml: "text/yaml",
    yml: "text/yaml",
    csv: "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function FileIcon({ path, className }: { path: string; className?: string }) {
  const mime = guessMime(path);
  const Icon = mime.startsWith("image/") ? Image : mime.startsWith("text/") || mime === "application/json" ? FileText : File;
  return <Icon className={cn("text-muted-foreground size-4 shrink-0", className)} />;
}

async function downloadFile(repoId: string, path: string, refName: string) {
  const data = await api<RepoReadResult>(
    `/v2/repos/${encodeURIComponent(repoId)}/files?${new URLSearchParams({ path, at: refName })}`,
  );
  const mime = guessMime(path);
  let blob: Blob;
  if (data.binary && data.base64) {
    const binary = atob(data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes], { type: mime });
  } else {
    blob = new Blob([data.content ?? ""], { type: mime });
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = nameOf(path);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FilePreviewDialog({
  repoId,
  refName,
  entry,
  onClose,
}: {
  repoId: string;
  refName: string;
  entry: RepoLsEntry;
  onClose: () => void;
}) {
  const [content, setContent] = useState<RepoReadResult>();
  const [error, setError] = useState<string>();
  const mime = guessMime(entry.path);

  useEffect(() => {
    let active = true;
    api<RepoReadResult>(
      `/v2/repos/${encodeURIComponent(repoId)}/files?${new URLSearchParams({ path: entry.path, at: refName, limit: String(128 * 1024) })}`,
    )
      .then(res => { if (active) setContent(res); })
      .catch(caught => { if (active) setError((caught as Error).message); });
    return () => { active = false; };
  }, [repoId, refName, entry.path]);

  const isImage = mime.startsWith("image/") && mime !== "image/svg+xml";

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{entry.path}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {mime} · {formatBytes(entry.size)}
            <Button size="xs" variant="outline" onClick={() => void downloadFile(repoId, entry.path, refName)}>
              <Download />Download
            </Button>
          </DialogDescription>
        </DialogHeader>
        <ErrorAlert error={error} />
        {!content && !error ? (
          <div className="flex justify-center py-8"><Loader2 className="animate-spin" /></div>
        ) : content && isImage && content.base64 ? (
          <img
            src={`data:${mime};base64,${content.base64}`}
            alt={nameOf(entry.path)}
            className="mx-auto max-h-[70dvh] object-contain"
          />
        ) : content && !content.binary ? (
          <pre className="bg-muted max-h-[70dvh] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
            {content.content ?? ""}
          </pre>
        ) : (
          <p className="text-muted-foreground text-sm">Binary file ({formatBytes(entry.size)}). Download it to view.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * CamelFS repository file browser backed by `/v2/repos/:repoId/ls`, `/files`, and `/write`.
 */
export function RepoBrowser({
  repoId,
  refName = "refs/heads/main",
  title = "Files",
  onChange,
}: {
  repoId: string;
  refName?: string;
  title?: ReactNode;
  onChange?: () => void;
}) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<RepoLsEntry[]>();
  const [commit, setCommit] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<RepoLsEntry>();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await api<{ commit: string; entries: RepoLsEntry[] }>(
        `/v2/repos/${encodeURIComponent(repoId)}/ls?${new URLSearchParams({ at: refName, recursive: "1" })}`,
      );
      setEntries(res.entries ?? []);
      setCommit(res.commit);
    } catch (caught) {
      if ((caught as { status?: number }).status === 404) {
        setEntries([]);
      } else {
        setError((caught as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [repoId, refName]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setDir(""); }, [repoId, refName]);

  async function upload(list: FileList | null) {
    const chosen = [...(list ?? [])];
    if (!chosen.length) return;
    setUploading(true);
    setError(undefined);
    try {
      const puts = await Promise.all(
        chosen.map(async file => ({
          path: joinPath(dir, file.name),
          base64: await fileToBase64(file),
        })),
      );
      await api(`/v2/repos/${encodeURIComponent(repoId)}/write`, {
        method: "POST",
        body: {
          ref: refName,
          message: `Upload ${chosen.map(f => f.name).join(", ")}`,
          puts,
        },
      });
      await load();
      onChange?.();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function remove(path: string) {
    setError(undefined);
    try {
      await api(`/v2/repos/${encodeURIComponent(repoId)}/write`, {
        method: "POST",
        body: { ref: refName, message: `Delete ${path}`, deletes: [path] },
      });
      await load();
      onChange?.();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  const fileEntries = (entries ?? []).filter(e => e.type === "file");
  const prefix = dir ? `${dir}/` : "";
  const folders = new Map<string, number>();
  const here: RepoLsEntry[] = [];
  for (const entry of fileEntries) {
    const normalized = entry.path.replace(/^\/+/, "");
    if (prefix && !normalized.startsWith(prefix)) continue;
    const rest = prefix ? normalized.slice(prefix.length) : normalized;
    const slash = rest.indexOf("/");
    if (slash < 0) here.push({ ...entry, path: normalized });
    else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
  }
  const crumbs = dir ? dir.split("/").filter(Boolean) : [];

  return (
    <Card
      className={cn(dragging && "ring-primary ring-2")}
      onDragOver={(event: DragEvent) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event: DragEvent) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {commit && <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">commit {commit.slice(0, 12)}</p>}
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={event => { void upload(event.target.files); event.target.value = ""; }}
        />
        <Button size="sm" variant="outline" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? <Loader2 className="animate-spin" /> : <Upload />}Upload
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ErrorAlert error={error} />
        <div className="flex flex-wrap items-center gap-1 font-mono text-xs">
          <button type="button" className="hover:underline" onClick={() => setDir("")}>/</button>
          {crumbs.map((crumb, index) => (
            <span key={index} className="inline-flex items-center gap-1">
              <ChevronRight className="text-muted-foreground size-3" />
              <button
                type="button"
                className="hover:underline"
                onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}
              >
                {crumb}
              </button>
            </span>
          ))}
        </div>
        {entries && !folders.size && !here.length ? (
          <p className="text-muted-foreground border border-dashed px-4 py-8 text-center text-sm">
            No files here. Drop files or click Upload to commit them to this repository.
          </p>
        ) : (
          <div className="bg-card border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="hidden sm:table-cell">Hash</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...folders].map(([name, count]) => (
                  <TableRow key={`dir:${name}`} className="cursor-pointer" onClick={() => setDir(joinPath(dir, name))}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 font-medium">
                        <Folder className="text-muted-foreground size-4" />{name}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{count} {count === 1 ? "file" : "files"}</TableCell>
                    <TableCell className="hidden sm:table-cell" />
                    <TableCell />
                  </TableRow>
                ))}
                {here.map(file => (
                  <TableRow key={file.path}>
                    <TableCell>
                      <button
                        type="button"
                        className="inline-flex max-w-xs items-center gap-2 text-left hover:underline"
                        onClick={() => setPreview(file)}
                      >
                        <FileIcon path={file.path} />
                        <span className="truncate font-mono text-xs">{nameOf(file.path)}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-xs">{formatBytes(file.size)}</TableCell>
                    <TableCell className="text-muted-foreground hidden font-mono text-xs sm:table-cell">
                      {file.hash.slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="icon-sm" variant="ghost" aria-label="Preview" onClick={() => setPreview(file)}>
                        <Eye />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Download"
                        onClick={() => void downloadFile(repoId, file.path, refName).catch(caught => setError((caught as Error).message))}
                      >
                        <Download />
                      </Button>
                      <ConfirmButton
                        label=""
                        icon={<Trash2 />}
                        variant="ghost"
                        size="xs"
                        title={`Delete ${nameOf(file.path)}?`}
                        description="Commits a deletion of this file on the current branch. Previous commits keep their copy."
                        confirm="Delete"
                        onConfirm={() => remove(file.path)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {loading && <div><Loader2 className="text-muted-foreground animate-spin" /></div>}
      </CardContent>
      {preview && (
        <FilePreviewDialog
          repoId={repoId}
          refName={refName}
          entry={preview}
          onClose={() => setPreview(undefined)}
        />
      )}
    </Card>
  );
}
