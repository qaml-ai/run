import { randomBytes } from "node:crypto";

/**
 * OpenTelemetry trace data as OTLP/HTTP sends it, in both of its encodings: JSON (`http/json`) and
 * protobuf (`http/protobuf`), written here rather than with the OpenTelemetry SDK. The runtime only
 * exports finished spans it builds itself, to each tenant's own collector, so it needs the wire format
 * and nothing of the SDK's tracer, context or processors; the encoders are the part of
 * opentelemetry-proto's trace and common messages that spans use, and tests check them against each other.
 */

/** An attribute's value: integers are sent as OTLP ints, other numbers as doubles; `{ double }` keeps a whole number a double. */
export type AttributeValue = string | number | boolean | { double: number } | string[];
export type Attributes = Record<string, AttributeValue | undefined>;
export const SpanKind = { internal: 1, server: 2, client: 3 } as const;
export type Span = {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  kind: (typeof SpanKind)[keyof typeof SpanKind];
  /** Epoch milliseconds, fractions allowed. */
  start: number; end: number;
  attributes: Attributes;
  /** Error spans carry a message; unset is the default, as instrumentations leave it. */
  status?: { code: "ok" | "error"; message?: string };
  links?: { traceId: string; spanId: string }[];
};
export type Scope = { name: string; version?: string };

/** A W3C trace context: the trace, the span it names, and whether that trace is sampled. */
export type TraceParent = { traceId: string; spanId: string; sampled: boolean };

export const newTraceId = () => randomBytes(16).toString("hex");
export const newSpanId = () => randomBytes(8).toString("hex");

/** A `traceparent` header (version 00, or a later version read as 00 allows), or undefined if it is not one. */
export function parseTraceparent(value: unknown): TraceParent | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/.exec(text);
  if (!match || match[1] === "ff" || (match[1] === "00" && match[5] !== undefined)) return undefined;
  if (/^0+$/.test(match[2]) || /^0+$/.test(match[3])) return undefined;
  return { traceId: match[2], spanId: match[3], sampled: (parseInt(match[4], 16) & 1) === 1 };
}

export const formatTraceparent = ({ traceId, spanId, sampled }: TraceParent) => `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;

/** Whether a trace is kept at `rate` (0 to 1), from its id alone, so every node decides the same for it. */
export function sampledAt(traceId: string, rate: number) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return parseInt(traceId.slice(-13), 16) / 2 ** 52 < rate;
}

const STATUS = { unset: 0, ok: 1, error: 2 } as const;
const entries = (attributes: Attributes) => Object.entries(attributes).filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined);
/** Epoch milliseconds as nanoseconds, exact to the microsecond. */
const nanos = (ms: number) => BigInt(Math.round(ms * 1000)) * 1000n;

// JSON ----------------------------------------------------------------------------------------------

function jsonValue(value: AttributeValue): object {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(jsonValue) } };
  return { doubleValue: value.double };
}
const jsonAttributes = (attributes: Attributes) => entries(attributes).map(([key, value]) => ({ key, value: jsonValue(value) }));

/** An ExportTraceServiceRequest in OTLP's JSON encoding: ids as hex, times as decimal strings, enums as numbers. */
export function otlpJson(resource: Attributes, scope: Scope, spans: Span[]) {
  return {
    resourceSpans: [{
      resource: { attributes: jsonAttributes(resource) },
      scopeSpans: [{
        scope: { name: scope.name, ...(scope.version ? { version: scope.version } : {}) },
        spans: spans.map(span => ({
          traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name, kind: span.kind,
          startTimeUnixNano: nanos(span.start).toString(), endTimeUnixNano: nanos(span.end).toString(),
          attributes: jsonAttributes(span.attributes),
          ...(span.links?.length ? { links: span.links.map(link => ({ traceId: link.traceId, spanId: link.spanId })) } : {}),
          status: span.status ? { code: STATUS[span.status.code], ...(span.status.message ? { message: span.status.message } : {}) } : {},
        })),
      }],
    }],
  };
}

// Protobuf ------------------------------------------------------------------------------------------

/** A protobuf message being written: fields in order, each a tag and its value. */
class Message {
  private readonly parts: Buffer[] = [];

  private varint(value: number | bigint) {
    let rest = BigInt.asUintN(64, BigInt(value));
    const bytes: number[] = [];
    while (rest > 127n) { bytes.push(Number(rest & 127n) | 128); rest >>= 7n; }
    bytes.push(Number(rest));
    this.parts.push(Buffer.from(bytes));
  }
  private tag(field: number, wire: 0 | 1 | 2 | 5) { this.varint((field << 3) | wire); }

  uint(field: number, value: number | bigint) { this.tag(field, 0); this.varint(value); return this; }
  bool(field: number, value: boolean) { return this.uint(field, value ? 1 : 0); }
  fixed64(field: number, value: bigint) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); this.tag(field, 1); this.parts.push(bytes); return this; }
  double(field: number, value: number) { const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value); this.tag(field, 1); this.parts.push(bytes); return this; }
  bytes(field: number, value: Buffer) { this.tag(field, 2); this.varint(value.length); this.parts.push(value); return this; }
  string(field: number, value: string) { return this.bytes(field, Buffer.from(value, "utf8")); }
  message(field: number, value: Message) { return this.bytes(field, value.finish()); }
  finish() { return Buffer.concat(this.parts); }
}

// opentelemetry.proto.common.v1.AnyValue: string 1, bool 2, int 3, double 4, array 5 (ArrayValue: values 1).
function anyValue(value: AttributeValue): Message {
  const message = new Message();
  if (typeof value === "string") return message.string(1, value);
  if (typeof value === "boolean") return message.bool(2, value);
  if (typeof value === "number") return Number.isInteger(value) ? message.uint(3, value) : message.double(4, value);
  if (Array.isArray(value)) {
    const array = new Message();
    for (const item of value) array.message(1, anyValue(item));
    return message.message(5, array);
  }
  return message.double(4, value.double);
}
// KeyValue: key 1, value 2.
function addAttributes(message: Message, field: number, attributes: Attributes) {
  for (const [key, value] of entries(attributes)) message.message(field, new Message().string(1, key).message(2, anyValue(value)));
}

/**
 * An ExportTraceServiceRequest in protobuf. Span: trace_id 1, span_id 2, parent_span_id 4, name 5, kind 6,
 * start 7 and end 8 (fixed64 ns), attributes 9, links 13 (trace_id 1, span_id 2), status 15 (message 2, code 3).
 */
export function otlpProtobuf(resource: Attributes, scope: Scope, spans: Span[]): Buffer {
  const scopeSpans = new Message();
  const instrumentation = new Message().string(1, scope.name);
  if (scope.version) instrumentation.string(2, scope.version);
  scopeSpans.message(1, instrumentation);
  for (const span of spans) {
    const message = new Message().bytes(1, Buffer.from(span.traceId, "hex")).bytes(2, Buffer.from(span.spanId, "hex"));
    if (span.parentSpanId) message.bytes(4, Buffer.from(span.parentSpanId, "hex"));
    message.string(5, span.name).uint(6, span.kind).fixed64(7, nanos(span.start)).fixed64(8, nanos(span.end));
    addAttributes(message, 9, span.attributes);
    for (const link of span.links ?? []) message.message(13, new Message().bytes(1, Buffer.from(link.traceId, "hex")).bytes(2, Buffer.from(link.spanId, "hex")));
    if (span.status) {
      const status = new Message();
      if (span.status.message) status.string(2, span.status.message);
      message.message(15, status.uint(3, STATUS[span.status.code]));
    }
    scopeSpans.message(2, message);
  }
  const resourceMessage = new Message();
  addAttributes(resourceMessage, 1, resource);
  const resourceSpans = new Message().message(1, resourceMessage).message(2, scopeSpans);
  return new Message().message(1, resourceSpans).finish();
}
