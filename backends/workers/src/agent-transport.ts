import { visibleReplay } from "./event-visibility.ts";
import { BrowserTokens } from "./browser-tokens.ts";
import { subscribedEvent, type EventSubscription } from "./event-socket.ts";
import { BadRequest, body } from "./validation.ts";
import { eventFrame, negotiateEvents, webSocketRequired, EVENT_PROTOCOL } from "./live-transport.ts";
import { createTenants } from "./security-services.ts";
import { digest } from "./api-contract.ts";
import { follow as followLiveTurn, replay as replayEvents, type LiveTurn } from "./live-event-policy.ts";
import { acknowledgeTerminalEvent, TERMINAL_EVENTS_PREFIX, type TerminalEvents, type TerminalDelivery } from "./event-log.ts";
import { inputWebhook, runWebhook, stageWebhook } from "./run-webhooks.ts";
import type { WebhookEvent } from "./webhook-policy.ts";
import { Config, RequestRecord, Env, json, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export async function emitImpl(this: AgentRuntime,
  event: unknown,
  delivery?: TerminalDelivery,
  webhook?: WebhookEvent) {
    let committed: { owner?: Config; record?: RequestRecord } = {};
    const work = this.serial.then(async () => {
      const cursor = await this.ctx.storage.transaction(async (tx) => {
        if (delivery && !(await acknowledgeTerminalEvent(tx, delivery)))
          return undefined;
        const next = ((await tx.get<number>("cursor")) ?? this.initialCursor) + 1;
        await tx.put("cursor", next);
        const value = event as any;
        const owner = await tx.get<Config>("configuration");
        const record = await tx.get<RequestRecord>(reqKey(value.requestId ?? value.id ?? ""));
        const announcement = webhook ?? (owner && record &&
          (value.type === "response" || value.event?.type === "agent_start")
          ? runWebhook(owner, value.type === "response" ? record : { ...record, state: "running" }, this.nextMessage)
          : owner && value.event?.type === "input_required"
            ? inputWebhook(owner, value.requestId, value.event.input) : undefined);
        if (announcement) await stageWebhook(tx, announcement);
        committed = { owner, record };
        const live = { cursor: next, events: [], turn: await tx.get<LiveTurn>("live-turn"), partial: this.partial };
        if (value.type === "event" && value.event?.type === "agent_start" && live.turn?.requestId !== value.requestId)
          live.turn = { requestId: value.requestId, count: 0, bytes: 0, messages: [] };
        followLiveTurn(live, value, JSON.stringify(value), false);
        if (live.turn) await tx.put("live-turn", live.turn);
        else await tx.delete("live-turn");
        this.eventLog.append(next, event);
        this.recentEvents.append(next, event);
        return next;
      });
      if (cursor === undefined) return;
      this.channels.observe(committed.owner, event as { type?: string; event?: { type?: string } }, committed.record && (event as { type?: string }).type === "response"
        ? { ...committed.record, outcome: (event as { outcome?: RequestRecord["outcome"] }).outcome ?? committed.record.outcome } : committed.record);
      for (const listener of this.listeners) listener(cursor, event);
      for (const socket of this.ctx.getWebSockets()) {
        try {
          const subscription = socket.deserializeAttachment() as EventSubscription;
          if (subscription.browser && subscription.browser.exp <= Date.now()) {
            this.closeBrowserSocket(socket);
            continue;
          }
          const visible = subscribedEvent(subscription, event);
          if (visible !== undefined) {
            socket.send(eventFrame(visible, cursor));
            const value = event as { type?: string; id?: string };
            if (subscription.run && value.type === "response" && value.id === subscription.request) {
              // End the readable protocol stream without waiting for the host's TCP close handshake.
              socket.send(eventFrame({ reason: "completed" }, undefined, "closed"));
              socket.close(1000, "Run completed");
            }
          }
        } catch {
          socket.close(1011, "Send failed");
        }
      }
    });
    this.serial = work.catch(() => {});
    await work;
    const value = event as any;
    if (webhook || value.type === "response" || ["agent_start", "input_required"].includes(value.event?.type))
      this.ctx.waitUntil(this.dbProfile.run("webhooks", () => this.webhooks.flush()));
  }

export async function flushTerminalEventsImpl(this: AgentRuntime) {
    if (
      this.env.TEST_MODEL === "1" &&
      (await this.testStorage.get("test:crash-events")) &&
      (await this.testStorage.get("test:crash-owner")) === this.instanceId
    )
      return;
    for (const [key, pending] of await this.ctx.storage.list<TerminalEvents>({
      prefix: TERMINAL_EVENTS_PREFIX,
      limit: 100,
    }))
      for (let index = pending.next; index < pending.events.length; index++)
        await this.emit(pending.events[index], { key, index });
    await this.dbProfile.run("webhooks", () => this.webhooks.flush());
  }

export async function recoverWatchersImpl(this: AgentRuntime) {
    this.watcherRecovery ??= (async () => {
      const conf = await this.ctx.storage.get<Config>("configuration");
      if (!conf) return;
      const ids = this.ctx.getWebSockets().filter(socket => socket.readyState === 1)
        .flatMap(socket => (socket.deserializeAttachment() as EventSubscription)?.watcher?.id ?? []);
      await this.env.TENANTS.getByName(conf.tenantId).reconcileWatchers(conf.id, ids);
    })().catch(error => { this.watcherRecovery = undefined; throw error; });
    return this.watcherRecovery;
  }

export async function closeWatchersImpl(this: AgentRuntime,
  tenant: string,
  agent: string) {
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Agent closed");
    await this.env.TENANTS.getByName(tenant).reconcileWatchers(agent, []);
  }

export async function checkWatchersImpl(this: AgentRuntime,
  tenant: string,
  agent: string) {
    await this.recoverWatchers();
    const limit = (await createTenants(this.env)).maxWatchers(tenant) ?? 1024;
    if (!await this.env.TENANTS.getByName(tenant).canWatch(limit, agent))
      throw Object.assign(new Error("This tenant has too many event stream subscribers; retry later"), { status: 429, retryAfter: 5 });
    return limit;
  }

export async function webSocketEventsImpl(this: AgentRuntime,
  request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bearer = request.headers.get("authorization") ?? "";
    const claims = BrowserTokens.carries(bearer)
      ? new BrowserTokens(this.env.AGENT_SESSION_SECRET ?? this.env.API_TOKEN).verify(bearer) : undefined;
    const watch = !!claims || url.searchParams.get("watch") === "1";
    if (watch && this.ctx.getWebSockets().filter(socket => socket.readyState === 1 &&
        (socket.deserializeAttachment() as EventSubscription)?.type === "camel.watcher").length >= 32)
      throw Object.assign(new Error("This agent has too many event stream subscribers; retry later"), { status: 429 });
    await this.observe();
    const runId = url.searchParams.get("runId");
    const replay = runId ? { snapshot: undefined, events: this.runReplay(request, runId) } : await this.replayEvents(request);
    const conf = await this.config();
    const subscription: EventSubscription = { type: watch ? "camel.watcher" : "camel.application",
      subagents: url.searchParams.get("subagents") === "1", request: runId ?? url.searchParams.get("request") ?? undefined,
      ...(runId ? { run: true } : {}),
      ...(claims ? { browser: { scopes: claims.scopes, events: claims.events, redact: claims.redact, exp: claims.exp } } : {}) };
    const previous =
      request.headers.get("X-Agent-Connection") ??
      url.searchParams.get("connection") ??
      undefined;
    const takeover = url.searchParams.get("takeover") === "true";
    if (!watch) await this.attached.prepareAttach(previous, takeover);
    const toolsHash = await digest(JSON.stringify(conf.config.mcp?.tools ?? []));
    if (watch) {
      const limit = await this.checkWatchers(conf.tenantId, conf.id), id = crypto.randomUUID();
      if (!await this.env.TENANTS.getByName(conf.tenantId).acquireWatcher(conf.id, id, limit))
        throw Object.assign(new Error("This tenant has too many event stream subscribers; retry later"), { status: 429, retryAfter: 5 });
      subscription.watcher = { tenant: conf.tenantId, id };
    }
    try {
    const pair = new WebSocketPair();
    const socket = pair[1];
    this.ctx.acceptWebSocket(socket);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    const connection = watch
      ? undefined
      : this.attached.attach(
          (event) => this.sendAttachedSocket(socket, event),
          previous,
          takeover,
          () => this.retireAttachedSocket(socket),
        );
    if (connection) {
      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const attachment = other.deserializeAttachment();
        if (attachment?.type === "camel.application" && attachment.serving) {
          other.serializeAttachment({ ...attachment, serving: false });
        }
      }
      Object.assign(subscription, { connection: connection.id, serving: true, initialized: false });
    }
    socket.serializeAttachment(subscription);
    socket.send(
      eventFrame(
        {
          version: 5,
          agentId: conf.id,
          ...(watch ? { watch: true } : {}),
          connection: connection?.id,
          toolsHash,
        },
        undefined,
        "ready",
      ),
    );
    if (connection)
      void connection
        .start()
        .then(() => {
          const attachment = socket.deserializeAttachment();
          socket.serializeAttachment({ ...attachment, initialized: true });
        })
        .catch(() => this.retireAttachedSocket(socket));
    if (replay.snapshot) {
      const visible = subscribedEvent(subscription, replay.snapshot);
      if (visible !== undefined) socket.send(eventFrame(visible, replay.snapshot.cursor));
    }
    for (const row of replay.events) {
      const visible = subscribedEvent(subscription, row.data);
      if (visible !== undefined) socket.send(eventFrame(visible, row.id));
      if (runId && (row.data as {type?:string}).type === "response") {
        socket.send(eventFrame({ reason: "completed" }, undefined, "closed"));
        socket.close(1000, "Run completed");
      }
    }
    if (claims) await this.arm();
    const selected = request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((x) => x.trim())
      .includes(EVENT_PROTOCOL);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: selected ? { "Sec-WebSocket-Protocol": EVENT_PROTOCOL } : {},
    });
    } catch (error) {
      if (subscription.watcher) await this.env.TENANTS.getByName(subscription.watcher.tenant).releaseWatcher(subscription.watcher.id);
      throw error;
    }
  }

/** Check ownership before returning the capability response: upgrade failures
   * cannot carry the SDK's typed HTTP refusal. */
export async function negotiateAgentEventsImpl(this: AgentRuntime,
  request: Request): Promise<Response | undefined> {
    const selected = negotiateEvents(request);
    if (!selected) return;
    const url = new URL(request.url);
    // The capability request preserves typed HTTP refusals before upgrade.
    if (url.searchParams.has("runId")) this.runReplay(request, url.searchParams.get("runId")!).next();
    else await this.replayEvents(request);
    if (url.searchParams.get("watch") === "1" && this.ctx.getWebSockets().filter(socket => socket.readyState === 1 &&
        (socket.deserializeAttachment() as EventSubscription)?.type === "camel.watcher").length >= 32)
      throw Object.assign(new Error("This agent has too many event stream subscribers; retry later"), { status: 429 });
    if (url.searchParams.get("watch") !== "1" && !url.searchParams.has("runId"))
      await this.attached.prepareAttach(
        request.headers.get("X-Agent-Connection") ?? undefined,
        url.searchParams.get("takeover") === "true",
      );
    // Directory forwarding strips the public prefix. The capability must point
    // the SDK back through the authenticated public route, not internal /events.
    const conf = await this.config();
    if (url.searchParams.get("watch") === "1") await this.checkWatchers(conf.tenantId, conf.id);
    return Response.json(
      {
        transport: "websocket",
        protocol: EVENT_PROTOCOL,
        url: `${request.headers.get("x-camel-events-path") ?? `/clients/${conf.id}/events`}${url.search}`,
      },
      { headers: selected.headers },
    );
  }

/** Socket attachments hold routing metadata only; credentials remain in the
   * authenticated request and are never retained in hibernation state. */
export function restoreWebSocketsImpl(this: AgentRuntime) {
    for (const socket of this.ctx.getWebSockets()) {
      const value = socket.deserializeAttachment();
      if (value?.type !== "camel.application") continue;
      if (!value.serving || !value.initialized || this.attached.connected) {
        this.retireAttachedSocket(socket);
        continue;
      }
      this.attached.restore(
        value.connection,
        (event) => this.sendAttachedSocket(socket, event),
        () => this.retireAttachedSocket(socket),
      );
    }
  }

export function sendAttachedSocketImpl(this: AgentRuntime,
  socket: WebSocket,
  event: unknown) {
    try {
      socket.send(eventFrame(event));
    } catch {
      const attachment = socket.deserializeAttachment();
      if (attachment?.type === "camel.application")
        this.attached.close(attachment.connection);
      try {
        socket.close(1011, "Send failed");
      } catch {}
    }
  }

export function closeBrowserSocketImpl(this: AgentRuntime,
  socket: WebSocket) {
    try { socket.send(eventFrame({ reason: "expired" }, undefined, "closed")); } catch {}
    socket.close(1008, "Browser token expired");
  }

export function retireAttachedSocketImpl(this: AgentRuntime,
  socket: WebSocket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.type === "camel.application")
      socket.serializeAttachment({ ...attachment, serving: false });
    try {
      socket.send(eventFrame({ reason: "replaced" }, undefined, "closed"));
    } catch {}
    try {
      socket.close(1000, "Connection retired");
    } catch {}
  }

export async function webSocketMessageImpl(this: AgentRuntime,
  socket: WebSocket,
  _data: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.type === "camel.application")
      this.attached.close(attachment.connection);
    socket.close(1008, "Read-only event stream");
  }

export async function webSocketCloseImpl(this: AgentRuntime,
  socket: WebSocket,
  code: number) {
    const attachment = socket.deserializeAttachment() as EventSubscription;
    if (attachment?.watcher) await this.env.TENANTS.getByName(attachment.watcher.tenant).releaseWatcher(attachment.watcher.id);
    if (attachment?.type === "camel.application")
      this.attached.close(attachment.connection);
    try {
      socket.close(
        code === 1000 || code === 1001 || (code >= 3000 && code <= 4999)
          ? code
          : 1000,
        "Closed",
      );
    } catch {}
  }

export async function webSocketErrorImpl(this: AgentRuntime,
  socket: WebSocket) {
    await this.webSocketClose(socket, 1011);
  }

export async function replayEventsImpl(this: AgentRuntime,
  request: Request) {
    const state = await this.state();
    const watch = new URL(request.url).searchParams.get("watch") === "1";
    const asked = new URL(request.url).searchParams.get("snapshot");
    const replay = replayEvents({ cursor: state.cursor, events: state.events,
      turn: await this.ctx.storage.get<LiveTurn>("live-turn"), partial: this.partial },
      request.headers.get("Last-Event-ID") ?? new URL(request.url).searchParams.get("cursor") ?? "0", watch ? asked !== "0" : asked === "1",
      Number((this.env as Env & { AGENT_SNAPSHOT_BYTES?: string }).AGENT_SNAPSHOT_BYTES) || undefined);
    return visibleReplay(replay, new URL(request.url).searchParams.get("subagents") === "1");
  }

export function* runReplayImpl(this: AgentRuntime,
  request: Request,
  id: string): Generator<{ id: number; data: unknown }> {
    const raw = request.headers.get("Last-Event-ID") ?? new URL(request.url).searchParams.get("cursor") ?? "0", after = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after)) throw new BadRequest("Invalid Last-Event-ID");
    let cursor = after;
    for (;;) {
      const page = this.eventLog.read(id, cursor, Number.MAX_SAFE_INTEGER);
      for (const row of page) yield { id: row.cursor, data: JSON.parse(row.body) };
      if (page.length < 128) return;
      cursor = page[page.length - 1].cursor;
    }
  }

export async function eventsImpl(this: AgentRuntime,
  request: Request): Promise<Response> {
    if (new URL(request.url).searchParams.get("poll") !== "1") return webSocketRequired();
    await this.observe();
    const state = await this.state();
    let replay = await this.replayEvents(request);
    if (new URL(request.url).searchParams.get("poll") === "1") {
      const seconds = Number(new URL(request.url).searchParams.get("wait") ?? 0);
      if (!Number.isFinite(seconds) || seconds < 0) throw new BadRequest("wait is a number of seconds");
      const wait = Math.min(25_000, seconds * 1000);
      if (!replay.snapshot && !replay.events.length && wait) {
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); this.listeners.delete(wake); request.signal.removeEventListener("abort", wake); resolve(); };
          const timer = setTimeout(wake, wait);
          this.listeners.add(wake);
          request.signal.addEventListener("abort", wake, { once: true });
        });
        replay = await this.replayEvents(request);
      }
      return json({ cursor: replay.cursor || state.cursor, events: [...(replay.snapshot ? [{ id: replay.snapshot.cursor, data: replay.snapshot }] : []), ...replay.events] });
    }
    return webSocketRequired();
  }
