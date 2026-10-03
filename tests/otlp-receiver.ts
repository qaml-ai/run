import { listen, type T } from "./runtime-server.ts";

/** A span as a receiver sees it, from either encoding: ids in hex, times in ms, attributes as plain values. */
export type ReceivedSpan = {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; start: number; end: number;
  attributes: Record<string, unknown>; status?: { code: number; message?: string }; links?: { traceId: string; spanId: string }[];
  resource: Record<string, unknown>; scope: { name: string; version?: string };
};

// Protobuf, decoded by hand: each field as [number, wire type, value].
type Field = [number, number, bigint | Buffer];
function fields(buffer: Buffer): Field[] {
  const out: Field[] = [];
  let at = 0;
  const varint = () => {
    let value = 0n, shift = 0n;
    for (;;) { const byte = buffer[at++]; value |= BigInt(byte & 127) << shift; if (!(byte & 128)) return value; shift += 7n; }
  };
  while (at < buffer.length) {
    const key = Number(varint());
    const [field, wire] = [key >> 3, key & 7];
    if (wire === 0) out.push([field, wire, varint()]);
    else if (wire === 1) { out.push([field, wire, buffer.subarray(at, at + 8)]); at += 8; }
    else if (wire === 2) { const length = Number(varint()); out.push([field, wire, buffer.subarray(at, at + length)]); at += length; }
    else if (wire === 5) { out.push([field, wire, buffer.subarray(at, at + 4)]); at += 4; }
    else throw new Error(`wire type ${wire}`);
  }
  return out;
}
const all = (list: Field[], field: number) => list.filter(entry => entry[0] === field).map(entry => entry[2]);
const one = (list: Field[], field: number) => all(list, field)[0];
function anyValue(buffer: Buffer): unknown {
  const [field, wire, value] = fields(buffer)[0];
  if (field === 1) return (value as Buffer).toString("utf8");
  if (field === 2) return value === 1n;
  if (field === 3) return Number(BigInt.asIntN(64, value as bigint));
  if (field === 4 && wire === 1) return (value as Buffer).readDoubleLE();
  if (field === 5) return all(fields(value as Buffer), 1).map(item => anyValue(item as Buffer));
  throw new Error(`AnyValue field ${field}`);
}
const protoAttributes = (list: Buffer[]) => Object.fromEntries(list.map(item => { const kv = fields(item); return [(one(kv, 1) as Buffer).toString("utf8"), anyValue(one(kv, 2) as Buffer)]; }));
const hex = (value: unknown) => (value as Buffer | undefined)?.toString("hex");

export function decodeProtobuf(body: Buffer): ReceivedSpan[] {
  return all(fields(body), 1).flatMap(resourceSpans => {
    const rs = fields(resourceSpans as Buffer);
    const resource = protoAttributes(all(fields((one(rs, 1) as Buffer | undefined) ?? Buffer.alloc(0)), 1) as Buffer[]);
    return all(rs, 2).flatMap(scopeSpans => {
      const ss = fields(scopeSpans as Buffer);
      const scopeFields = fields(one(ss, 1) as Buffer);
      const scope = { name: (one(scopeFields, 1) as Buffer).toString("utf8"), ...(one(scopeFields, 2) ? { version: (one(scopeFields, 2) as Buffer).toString("utf8") } : {}) };
      return all(ss, 2).map(spanBuffer => {
        const span = fields(spanBuffer as Buffer);
        const status = one(span, 15) as Buffer | undefined;
        const statusFields = status ? fields(status) : undefined;
        const links = all(span, 13).map(link => { const l = fields(link as Buffer); return { traceId: hex(one(l, 1))!, spanId: hex(one(l, 2))! }; });
        return {
          traceId: hex(one(span, 1))!, spanId: hex(one(span, 2))!, ...(one(span, 4) ? { parentSpanId: hex(one(span, 4)) } : {}),
          name: (one(span, 5) as Buffer).toString("utf8"), kind: Number(one(span, 6) ?? 0n),
          start: Number((one(span, 7) as Buffer).readBigUInt64LE() / 1000n) / 1000, end: Number((one(span, 8) as Buffer).readBigUInt64LE() / 1000n) / 1000,
          attributes: protoAttributes(all(span, 9) as Buffer[]),
          ...(statusFields ? { status: { code: Number(one(statusFields, 3) ?? 0n), ...(one(statusFields, 2) ? { message: (one(statusFields, 2) as Buffer).toString("utf8") } : {}) } } : {}),
          ...(links.length ? { links } : {}),
          resource, scope,
        };
      });
    });
  });
}

const jsonValue = (value: any): unknown => "stringValue" in value ? value.stringValue : "boolValue" in value ? value.boolValue : "intValue" in value ? Number(value.intValue)
  : "doubleValue" in value ? value.doubleValue : "arrayValue" in value ? value.arrayValue.values.map(jsonValue) : undefined;
const jsonAttributes = (list: any[] = []) => Object.fromEntries(list.map(entry => [entry.key, jsonValue(entry.value)]));

export function decodeJson(body: any): ReceivedSpan[] {
  return body.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans.map((span: any) => ({
    traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}), name: span.name, kind: span.kind,
    start: Number(BigInt(span.startTimeUnixNano) / 1000n) / 1000, end: Number(BigInt(span.endTimeUnixNano) / 1000n) / 1000,
    attributes: jsonAttributes(span.attributes),
    ...(span.status?.code !== undefined ? { status: { code: span.status.code, ...(span.status.message ? { message: span.status.message } : {}) } } : {}),
    ...(span.links?.length ? { links: span.links } : {}),
    resource: jsonAttributes(rs.resource?.attributes), scope: ss.scope,
  }))));
}

/**
 * An OTLP/HTTP traces receiver: decodes each export (protobuf or JSON, by its content type) into `spans`, and keeps
 * each request's headers and raw body. `status` answers with something else (a function: per request).
 */
export async function otlpReceiver(t: T, status: number | ((index: number) => number | "hang") = 200) {
  const requests: { headers: Record<string, any>; body: Buffer; path: string }[] = [];
  const spans: ReceivedSpan[] = [];
  const url = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const index = requests.push({ headers: req.headers, body, path: req.url ?? "" }) - 1;
    const answer = typeof status === "function" ? status(index) : status;
    if (answer === "hang") return;
    if (answer >= 200 && answer < 300) {
      spans.push(...(req.headers["content-type"] === "application/json" ? decodeJson(JSON.parse(body.toString("utf8"))) : decodeProtobuf(body)));
    }
    res.writeHead(answer, { "Content-Type": "application/json" }).end("{}");
  });
  return { url, endpoint: `${url}/v1/traces`, requests, spans, raw: () => Buffer.concat(requests.map(request => request.body)).toString("latin1") };
}
