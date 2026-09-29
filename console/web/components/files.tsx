import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronRight, Download, Eye, File, FileText, Folder, Image, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton, ErrorAlert } from "@/components/common";
import { api, filePath, formatBytes, formatTime, putFile, signLink, type VolumeFile } from "@/lib/api";
import { cn } from "@/lib/utils";

const TEXT_PREVIEW = 64 * 1024;
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const isText = (type: string) => type.startsWith("text/") || /json|xml|javascript|yaml|csv/.test(type);

/** A signed GET link for a volume file, made once per file. */
export function useSignedUrl(volume: string | undefined, path: string | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!volume || !path) return;
    let live = true;
    signLink(volume, path).then(link => { if (live) setUrl(link.url); }, () => undefined);
    return () => { live = false; };
  }, [volume, path]);
  return url;
}

async function download(volume: string, path: string) {
  const anchor = document.createElement("a");
  anchor.href = (await signLink(volume, path)).url;
  anchor.download = nameOf(path);
  anchor.click();
}

export function FileIcon({ contentType, className }: { contentType: string; className?: string }) {
  const Icon = contentType.startsWith("image/") ? Image : isText(contentType) || contentType === "application/pdf" ? FileText : File;
  return <Icon className={cn("text-muted-foreground size-4 shrink-0", className)} />;
}

/** Shows an image or PDF from a signed link, or the first 64 KB of a text file. */
export function FilePreview({ volume, file, onClose }: { volume: string; file: Pick<VolumeFile, "path" | "contentType" | "size">; onClose: () => void }) {
  const kind = file.contentType.startsWith("image/") ? "image" : file.contentType === "application/pdf" ? "pdf" : isText(file.contentType) ? "text" : undefined;
  const url = useSignedUrl(kind === "image" || kind === "pdf" ? volume : undefined, file.path);
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (kind !== "text") return;
    fetch(`/v1/volumes/${volume}/files/${filePath(file.path)}`, { credentials: "same-origin", headers: { Range: `bytes=0-${TEXT_PREVIEW - 1}` } })
      .then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); setText(await response.text()); })
      .catch(caught => setError((caught as Error).message));
  }, [kind, volume, file.path]);
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">{nameOf(file.path)}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {file.contentType} · {formatBytes(file.size)}
            <Button size="xs" variant="outline" onClick={() => void download(volume, file.path)}><Download />Download</Button>
          </DialogDescription>
        </DialogHeader>
        <ErrorAlert error={error} />
        {kind === "image" ? (url ? <img src={url} alt={nameOf(file.path)} className="mx-auto max-h-[70dvh] object-contain" /> : <Loader2 className="mx-auto animate-spin" />)
          : kind === "pdf" ? (url ? <iframe src={url} title={nameOf(file.path)} className="h-[70dvh] w-full border" /> : <Loader2 className="mx-auto animate-spin" />)
          : kind === "text" ? (
            <pre className="bg-muted max-h-[70dvh] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
              {text ?? "Loading…"}{text !== undefined && file.size > TEXT_PREVIEW && `\n\n… (first ${formatBytes(TEXT_PREVIEW)} of ${formatBytes(file.size)})`}
            </pre>
          ) : <p className="text-muted-foreground text-sm">No preview for this type. Download it instead.</p>}
      </DialogContent>
    </Dialog>
  );
}

/** A file in a message or a result: an image thumbnail or an icon, its name, type and size, and a download button. */
export function FileCard({ volume, path, contentType, size, caption, shown }: {
  volume?: string; path?: string; contentType: string; size?: number; caption?: ReactNode; shown: string;
}) {
  const image = contentType.startsWith("image/");
  const url = useSignedUrl(image ? volume : undefined, path);
  const [previewing, setPreviewing] = useState(false);
  const [failed, setFailed] = useState(false);
  const available = volume && path;
  return (
    <div className="bg-background flex max-w-sm items-center gap-3 rounded-md border p-2 text-left text-xs">
      <button type="button" disabled={!available} onClick={() => setPreviewing(true)} className="shrink-0 cursor-pointer disabled:cursor-default" aria-label={`Preview ${nameOf(shown)}`}>
        {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} className="size-12 object-cover" />
          : <div className="bg-muted flex size-12 items-center justify-center"><FileIcon contentType={contentType} className="size-5" /></div>}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={shown}>{nameOf(shown)}</div>
        <div className="text-muted-foreground truncate">{contentType}{size !== undefined && ` · ${formatBytes(size)}`}</div>
        {caption && <div className="mt-0.5">{caption}</div>}
      </div>
      {available && <Button size="icon-sm" variant="ghost" aria-label="Download" onClick={() => void download(volume, path)}><Download /></Button>}
      {previewing && available && <FilePreview volume={volume} file={{ path, contentType, size: size ?? 0 }} onClose={() => setPreviewing(false)} />}
    </div>
  );
}

/**
 * Browses a volume from `root`: folders derived from the listed paths, uploads by button or drop
 * with progress, previews, downloads by signed link, and deletes. Pages with the API's cursor.
 */
export function FileBrowser({ volume, root = "/", title = "Files", onChange }: { volume: string; root?: string; title?: ReactNode; onChange?: () => void }) {
  const [dir, setDir] = useState(root);
  const [files, setFiles] = useState<VolumeFile[]>();
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const [preview, setPreview] = useState<VolumeFile>();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async (after?: string) => {
    setLoading(true); setError(undefined);
    try {
      const page = await api<{ files: VolumeFile[]; next?: string }>(`/v1/volumes/${volume}/files?${new URLSearchParams({ prefix: dir, ...(after ? { after } : {}) })}`);
      setFiles(previous => after ? [...previous ?? [], ...page.files] : page.files);
      setNext(page.next);
    } catch (caught) {
      // An empty volume (or folder) has no directory to list yet.
      if ((caught as { status?: number }).status === 404) { setFiles([]); setNext(undefined); } else setError((caught as Error).message);
    } finally { setLoading(false); }
  }, [volume, dir]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => setDir(root), [root, volume]);

  async function upload(list: FileList | null) {
    const chosen = [...list ?? []];
    if (!chosen.length) return;
    setError(undefined);
    setUploads(chosen.map(file => ({ name: file.name, progress: 0 })));
    await Promise.all(chosen.map((file, index) => putFile(`/v1/volumes/${volume}/files/${filePath(join(dir, file.name))}`, file,
      progress => setUploads(current => current.map((entry, at) => at === index ? { ...entry, progress } : entry)))
      .catch(caught => setError(`${file.name}: ${(caught as Error).message}`))));
    setUploads([]);
    await load();
    onChange?.();
  }
  async function remove(path: string) {
    try { await api(`/v1/volumes/${volume}/files/${filePath(path)}`, { method: "DELETE" }); await load(); onChange?.(); }
    catch (caught) { setError((caught as Error).message); }
  }

  const prefix = dir === "/" ? "/" : `${dir}/`;
  const folders = new Map<string, number>();
  const here: VolumeFile[] = [];
  for (const file of files ?? []) {
    const rest = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : nameOf(file.path);
    const slash = rest.indexOf("/");
    if (slash < 0) here.push(file);
    else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
  }
  const crumbs = dir.slice(root.length).split("/").filter(Boolean);

  return (
    <Card
      className={cn(dragging && "ring-primary ring-2")}
      onDragOver={(event: DragEvent) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event: DragEvent) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <input ref={input} type="file" multiple hidden onChange={event => { void upload(event.target.files); event.target.value = ""; }} />
        <Button size="sm" variant="outline" disabled={uploads.length > 0} onClick={() => input.current?.click()}><Upload />Upload</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ErrorAlert error={error} />
        <div className="flex flex-wrap items-center gap-1 font-mono text-xs">
          <button type="button" className="hover:underline" onClick={() => setDir(root)}>{root}</button>
          {crumbs.map((crumb, index) => (
            <span key={index} className="inline-flex items-center gap-1">
              <ChevronRight className="text-muted-foreground size-3" />
              <button type="button" className="hover:underline" onClick={() => setDir(join(root, crumbs.slice(0, index + 1).join("/")))}>{crumb}</button>
            </span>
          ))}
        </div>
        {uploads.map(entry => (
          <div key={entry.name} className="flex items-center gap-3 text-xs"><span className="w-48 truncate">{entry.name}</span><Progress value={entry.progress * 100} /></div>
        ))}
        {files && !folders.size && !here.length ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">No files here. Drop files to upload them.</p>
        ) : (
          <div className="bg-card border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Name</TableHead><TableHead className="hidden md:table-cell">Type</TableHead><TableHead>Size</TableHead>
                <TableHead className="hidden lg:table-cell">Updated</TableHead><TableHead className="hidden sm:table-cell">Version</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {[...folders].map(([name, count]) => (
                  <TableRow key={`dir:${name}`} className="cursor-pointer" onClick={() => setDir(join(dir, name))}>
                    <TableCell><span className="inline-flex items-center gap-2 font-medium"><Folder className="text-muted-foreground size-4" />{name}</span></TableCell>
                    <TableCell className="text-muted-foreground hidden md:table-cell">folder</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{count}{next ? "+" : ""} {count === 1 && !next ? "file" : "files"}</TableCell>
                    <TableCell className="hidden lg:table-cell" /><TableCell className="hidden sm:table-cell" /><TableCell />
                  </TableRow>
                ))}
                {here.map(file => (
                  <TableRow key={file.path}>
                    <TableCell>
                      <button type="button" className="inline-flex max-w-xs items-center gap-2 text-left hover:underline" onClick={() => setPreview(file)}>
                        <FileIcon contentType={file.contentType} /><span className="truncate">{nameOf(file.path)}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">{file.contentType}</TableCell>
                    <TableCell className="text-xs">{formatBytes(file.size)}</TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs lg:table-cell" title={file.by && `by ${file.by}`}>{formatTime(file.updatedAt)}</TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs sm:table-cell">{file.version}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="icon-sm" variant="ghost" aria-label="Preview" onClick={() => setPreview(file)}><Eye /></Button>
                      <Button size="icon-sm" variant="ghost" aria-label="Download" onClick={() => void download(volume, file.path).catch(caught => setError((caught as Error).message))}><Download /></Button>
                      <ConfirmButton label="" icon={<Trash2 />} variant="ghost" size="xs" title={`Delete ${nameOf(file.path)}?`} description="The file is removed from the volume. Snapshots that include it keep their copy." confirm="Delete" onConfirm={() => remove(file.path)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {(loading || next) && (
          <div>{loading ? <Loader2 className="text-muted-foreground animate-spin" /> : <Button size="sm" variant="outline" onClick={() => void load(next)}>Load more</Button>}</div>
        )}
      </CardContent>
      {preview && <FilePreview volume={volume} file={preview} onClose={() => setPreview(undefined)} />}
    </Card>
  );
}
