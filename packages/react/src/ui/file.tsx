import { memo, useCallback, useEffect, useState } from "react";
import type { FilePart } from "@camelai/agent-runtime/chat";
import { useAgent } from "../index.tsx";
import { useUI } from "./context.tsx";

const size = (bytes?: number) => bytes === undefined ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/**
 * A file the agent handed over: an image inline, anything else as a download. Its signed link comes
 * with the stream when it is presented; for older files it is fetched through your handler, and
 * fetched again before a click once it is about to expire.
 */
export const FilePreview = memo(function FilePreview({ part }: { part: FilePart }) {
  const chat = useAgent();
  const { labels } = useUI();
  const [url, setUrl] = useState(part.url);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    chat.fileUrl(part.path).then(link => { setUrl(link); setFailed(false); }, () => setFailed(true));
  }, [chat, part.path]);
  useEffect(() => { if (part.url) setUrl(part.url); else refresh(); }, [part.url, refresh]);
  const image = part.contentType?.startsWith("image/") && part.contentType !== "image/svg+xml";
  return (
    <figure className="agent-chat__file" data-kind={image ? "image" : "file"}>
      {image && url && !failed && <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={part.caption ?? part.name} loading="lazy" onError={() => setFailed(true)} /></a>}
      <figcaption>
        <a className="agent-chat__file-link" href={url} target="_blank" rel="noopener noreferrer" download={part.name}
          onMouseEnter={refresh} onFocus={refresh} aria-disabled={!url || undefined}>
          <span className="agent-chat__file-name">{part.name}</span>
          <span className="agent-chat__file-meta">{[size(part.size), labels.download].filter(Boolean).join(" · ")}</span>
        </a>
        {part.caption && <span className="agent-chat__file-caption">{part.caption}</span>}
      </figcaption>
    </figure>
  );
});
