import type { Socket } from "node:net";

/**
 * Larger than any legitimate frame: 256 KB of code or a 1 MiB tool result, JSON-escaped
 * once more. Either side destroys the connection on anything bigger instead of buffering it.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Length-prefixed JSON frames over a stream socket, one execution per connection.
 * A frame that is oversized or not JSON destroys the socket.
 */
export function frames(socket: Socket, onMessage: (message: unknown) => void, maxBytes = MAX_FRAME_BYTES) {
  // Chunks are joined only once a whole frame has arrived, so a large frame is copied once.
  let chunks: Buffer[] = [];
  let size = 0;
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    while (size >= 4 && !socket.destroyed) {
      if (chunks[0].length < 4) chunks = [Buffer.concat(chunks, size)];
      const length = chunks[0].readUInt32BE(0);
      if (length > maxBytes) return void socket.destroy(new Error("Sandbox frame exceeds size limit"));
      if (size < 4 + length) return;
      const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      const body = joined.subarray(4, 4 + length);
      const rest = joined.subarray(4 + length);
      chunks = rest.length ? [rest] : [];
      size = rest.length;
      let message: unknown;
      try { message = JSON.parse(body.toString("utf8")); }
      catch { return void socket.destroy(new Error("Sandbox frame is not JSON")); }
      onMessage(message);
    }
  });
  return (message: unknown) => {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > maxBytes) throw new Error("Sandbox frame exceeds size limit");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length);
    socket.cork();
    socket.write(header);
    socket.write(body);
    socket.uncork();
  };
}
