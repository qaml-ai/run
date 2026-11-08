import { keyServices } from "./security-services.ts";
import { EndUserCredits } from "./end-user-credits.ts";
import { admitAgentMessage } from "./message-admission.ts";
import { MULTI_AGENT_LIMITS, viaParent } from "./multi-agent-policy.ts";
import { childParent } from "./child-parent.ts";
import { refreshIdleLifetime } from "./idle-lifetime.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BadRequest, boundedText, object } from "./validation.ts";
import { Directory, releaseTurn } from "./control.ts";
import { type Mount } from "./files.ts";
import { imageReferenceInput, type ImageRef } from "./images.ts";
import { PromptAttachments, attachmentInput, attachmentFiles } from "./prompt-attachments.ts";
import { actorInput, bucketInput } from "./security-policy.ts";
import { ConfigurationQueue } from "./configuration-queue.ts";
import { replacementConfiguration } from "./replacement-configuration.ts";
import { digest, configuration } from "./api-contract.ts";
import { configurationModelError, validateAgentModel } from "./default-model.ts";
import { MAX_OPEN_REQUESTS } from "./access-policy.ts";
import { configurationPatch, withoutOnExpire, definitionApplication, definitionUpsert, type DefinitionTarget } from "./definitions.ts";
import { executionParams } from "./host-execution.ts";
import { outputInput } from "./output-validation.ts";
import { runLimitsInput } from "./model-policy.ts";
import { type RuntimeNotice, type NoticeDelivery } from "./delegation-notifications.ts";
import { metadataInput, senderInput } from "./sender.ts";
import { setAgentSpendLimit, agentSpendRefusal, spendInput, runSpend } from "./agent-spend.ts";
import { withSql } from "./postgres.ts";
import { RequestRecord, canonical, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export function createConfigurationQueue(this: AgentRuntime): ConfigurationQueue<RequestRecord> {
  return new ConfigurationQueue<RequestRecord>(this.ctx.storage, {
    busy: async order => (await this.harness.session().busy()) || (await this.records()).some(record => record.method !== 'configure' && record.state !== 'completed' && (record.configurationWait === undefined || record.configurationWait < order)),
    released: order => this.releaseConfigurationWaiters(order),
    apply: record => this.applyConfigurationRequest({ id: record.id, method: record.method, params: record.params }, record.configurationOrigin),
    failed: async (record, error) => {
      const completed = { ...record, state: 'completed' as const, endedAt: Date.now(), outcome: { error: error instanceof Error ? error.message : String(error) } };
      await this.ctx.storage.put(reqKey(record.id), completed);
      await this.emit({ type: 'response', id: record.id, outcome: completed.outcome });
    },
    background: work => this.ctx.waitUntil(work),
    wake: () => this.arm(Date.now() + 1000),
  });
}

export async function releaseConfigurationWaitersImpl(this: AgentRuntime,
  order: number) {
    const pending = (await this.records()).sort((a, b) => (a.configurationWaitSequence ?? 0) - (b.configurationWaitSequence ?? 0));
    for (const record of pending) {
      if (record.state === 'completed' || record.configurationWait === undefined || record.configurationWait > order) continue;
      // Attachment bytes have already become stored file references. This is
      // internal continuation of the accepted request, not a new caller input.
      try { await this.submit({ id: record.id, method: record.method, params: record.params }, undefined, undefined, record.fingerprint); }
      catch (error) {
        const completed = { ...record, state: 'completed' as const, endedAt: Date.now(), outcome: { error: error instanceof Error ? error.message : String(error) } };
        await this.ctx.storage.put(reqKey(record.id), completed);
        const conf = await this.config();
        await releaseTurn(this.env, conf.tenantId, conf.id, record.id);
        await this.env.TENANTS.getByName(conf.tenantId).release(`${conf.id}:${record.id}`);
        await this.emit({ type: 'response', id: record.id, outcome: completed.outcome });
      }
    }
  }

export async function configureRequestImpl(this: AgentRuntime,
  input: unknown,
  replacement = false,
  origin?: string) {
    const accepted = this.admission.then(() => this.acceptConfigurationRequest(input, replacement, origin));
    this.admission = accepted.catch(() => {});
    return accepted;
  }

export async function acceptConfigurationRequestImpl(this: AgentRuntime,
  input: unknown,
  replacement: boolean,
  origin?: string) {
    const request = object(input, ['id', 'method', 'params']);
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new BadRequest('Expected configuration object');
    const id = boundedText(request.id, 'id', 80);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new BadRequest('Invalid request id');
    if (!replacement && !Object.keys(request.params).length) throw new BadRequest("Give at least one configuration field");
    const conf = await this.config();
    const given = request.params as Record<string, unknown>;
    // A definition revision (only from the directory's /configuration-target) is checked against the configuration
    // now, and merged with the configuration it finds when it applies.
    const params = replacement && given.applyDefinition !== undefined
      ? await definitionApplication(this.env, conf.tenantId, conf.config, given.applyDefinition as DefinitionTarget) as Record<string, unknown>
      : given;
    if (params.subject !== undefined && params.subject !== conf.config.subject)
      throw Object.assign(new Error("An agent's subject cannot change"), { status: 409 });
    const patched = replacement ? configuration(params, conf.config.model ?? this.env.MODEL).config : await configurationPatch(this.env, conf.tenantId, withoutOnExpire(conf.config), params);
    configuration(patched, conf.config.model ?? this.env.MODEL, "patch");
    await validateAgentModel(this.env, conf.tenantId, patched, { reference: conf.config.model, model: conf.resolvedModel });
    if (replacement && (params.model !== undefined || params.keyScope !== undefined)) {
      try {
        const error = await configurationModelError(this.env, conf.tenantId, patched);
        if (error) throw new BadRequest(error);
      } catch (error) { throw new BadRequest(error instanceof Error ? error.message : String(error)); }
    }
    if (!await this.ctx.storage.get(reqKey(id))) {
      if ((await this.records()).filter(record => record.state !== 'completed').length >= MAX_OPEN_REQUESTS)
        throw Object.assign(new Error('Too many requests queued for this agent'), { status: 429 });
      // Like the source runtime, a new allowance takes effect before queued work.
      // Replaying the request must not reset its already consumed counter.
      if (Object.hasOwn(request.params, 'spendLimit'))
        await setAgentSpendLimit(this.env, conf.tenantId, conf.id, (request.params as Record<string, unknown>).spendLimit);
    }
    return this.configurationQueue.enqueue({ id, method: 'configure', params: given }, replacement, origin);
  }

export async function applyConfigurationRequestImpl(this: AgentRuntime,
  input: unknown,
  origin?: string) {
    const request = object(input, ["id", "method", "params"]);
    const id = boundedText(request.id, "id", 80);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new BadRequest("Invalid request id");
    if (await this.ctx.storage.get(`cancelled-request:${id}`))
      throw Object.assign(new Error("Request cancelled"), {
        status: 409,
        code: "aborted",
      });
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params))
      throw new BadRequest("Expected configuration object");
    const given = request.params as Record<string, unknown>;
    const conf = await this.config();
    const replacement = (await this.ctx.storage.get<RequestRecord>(reqKey(id)))?.replaceConfiguration === true;
    // A definition application merges its revision with the configuration as it is now, at the head of the queue, so
    // configuration queued before it stays. Keyed upserts inherit the definition revision the agent has by then.
    const applying = replacement && given.applyDefinition !== undefined;
    const params = applying
      ? await definitionApplication(this.env, conf.tenantId, conf.config, given.applyDefinition as DefinitionTarget) as Record<string, unknown>
      : given;
    const replacementInput = replacement && params.definition !== undefined && !applying
      ? definitionUpsert(params, conf.config) : params;
    const replacementParams = replacement ? replacementConfiguration(withoutOnExpire(conf.config), replacementInput) : params;
    const patched = configuration(replacement ? replacementParams : { ...withoutOnExpire(conf.config), ...params }, conf.config.model ?? this.env.MODEL, replacement ? "create" : "patch").config;
    const modelError = (params.model !== undefined || params.keyScope !== undefined)
      ? await configurationModelError(this.env, conf.tenantId, patched) : undefined;
    const fingerprint = canonical(request);
    const previous = await this.ctx.storage.transaction(async (tx) => {
      const old = await tx.get<RequestRecord>(reqKey(id));
      if (old && old.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Request id reused with different input"),
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
      if (!old)
        await tx.put(reqKey(id), {
          id,
          method: "configure",
          fingerprint,
          state: "running",
          startedAt: Date.now(),
        } satisfies RequestRecord);
      return old;
    });
    if (previous?.state === "completed") return previous;
    if (modelError) {
      const failed: RequestRecord = { ...previous, id, method: "configure", fingerprint, state: "completed", startedAt: previous?.startedAt ?? Date.now(), endedAt: Date.now(), outcome: { error: modelError } };
      await this.ctx.storage.put(reqKey(id), failed);
      await this.emit({ type: "response", id, outcome: failed.outcome });
      return failed;
    }
    const directory = new Directory(this.env, conf.tenantId);
    const current = await directory.get(conf.id);
    if (!current)
      throw Object.assign(new Error("Unknown agent"), { status: 404 });
    const updated = await directory.upsert(
      previous?.replaceConfiguration ? replacementParams : await configurationPatch(this.env, conf.tenantId, current.config, params),
      current.key ?? current.id,
      origin ?? conf.runtimeOrigin,
    );
    if ("failed" in updated)
      throw Object.assign(new Error(updated.error), {
        status: updated.status,
        code: updated.code,
      });
    const record: RequestRecord = {
      ...previous,
      id,
      method: "configure",
      fingerprint,
      state: "completed",
      startedAt: previous?.startedAt ?? Date.now(),
      endedAt: Date.now(),
      outcome: { result: { configured: true, changed: current.configHash !== updated.configHash, configHash: updated.configHash } },
    };
    await this.ctx.storage.put(reqKey(id), record);
    await this.emit({ type: "response", id, outcome: record.outcome });
    return record;
  }

export async function requireApplicationImpl(this: AgentRuntime,
  allowDisconnected: unknown) {
    if (allowDisconnected !== undefined && typeof allowDisconnected !== "boolean")
      throw new BadRequest("allowDisconnected must be a boolean");
    if (allowDisconnected === true || !(await this.config()).config.mcp?.tools?.length) return;
    if (await this.attached.waitUntilReady()) return;
    throw Object.assign(
      new Error("APPLICATION_NOT_CONNECTED: this agent's tools are answered by its application, and none is connected. Connect it: upsert the agent with its tools in a process that stays up (TypeScript agents.upsert(key, { tools }), Python agents.upsert(key, tools=[…]); lower down, connectAgent or connect_agent), or send allowDisconnected: true (allow_disconnected=True) to run anyway"),
      { status: 409, code: "APPLICATION_NOT_CONNECTED" },
    );
  }

export async function admitImpl(this: AgentRuntime,
  input: unknown,
  notice?: RuntimeNotice,
  delivery?: NoticeDelivery,
  acceptedFingerprint?: string) {
    await this.config();
    const request = object(input, ["id", "method", "params"]);
    // The old steer request spelling shares prompt payer checks and own-turn fallback.
    if (request.method === "steer") {
      request.method = "prompt";
      if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) throw new BadRequest("Expected a JSON object");
      request.params = { ...request.params, whileRunning: "steer" };
    }
    const id = boundedText(request.id, "id", 80);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new BadRequest("Invalid request id");
    // A sub-agent the runtime made runs only what its parent sends it: a run signed into its parent's chain, or a message
    // or notification of the runtime's. Anyone else's prompt, steer, continue or code is refused (answering its inputs still resumes it).
    if (!notice && ["prompt", "steer", "continue", "execute"].includes(String(request.method))) {
      const conf = await this.config();
      const metadata = request.params && typeof request.params === "object" ? (request.params as { metadata?: unknown }).metadata : undefined;
      if (conf.config.type === "subagent" && !await this.delegation.lineage(conf.id, { id, metadata })
        && await childParent(this.env, conf.tenantId, conf.id))
        throw viaParent(conf.id);
    }
    if (request.method === "execute") {
      let params;
      const raw = object(request.params, [
        "code",
        "timeoutMs",
        "maxOutputCharacters",
        "actor",
        "allowDisconnected",
      ]);
      const { actor, allowDisconnected, ...code } = raw;
      try {
        params = executionParams(code);
      } catch (error) {
        throw new BadRequest((error as Error).message);
      }
      if (
        actor !== undefined &&
        (typeof actor !== "string" || actor.length > 512)
      )
        throw new BadRequest("Invalid actor");
      const fingerprint = canonical({
        method: "execute",
        params,
        actor,
        allowDisconnected,
      });
      const old = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (old && old.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Request id reused with different input"),
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
      if (old) return old.accepted || old.state === "completed" ? this.replayedRequest(old) : this.startHostRequest(old);
      if (await this.ctx.storage.get(`cancelled-request:${id}`))
        throw Object.assign(new Error("Request cancelled"), { status: 409, code: "aborted" });
      await this.requireApplication(allowDisconnected);
      await refreshIdleLifetime(this.env, this.ctx.storage, await this.config());
      const record: RequestRecord = {
        id,
        method: "execute",
        fingerprint,
        params: { ...params, ...(actor ? { actor } : {}) },
        accepted: false,
        state: "queued",
        startedAt: Date.now(),
      };
      return this.startHostRequest(record);
    }
    if (request.method === "abort") {
      const params = object(request.params ?? {}, ["queued", "children"]);
      if (params.queued !== undefined && !['cancel', 'keep'].includes(String(params.queued)))
        throw new BadRequest('queued is cancel or keep');
      // abort is the documented value (as on Node and in the SDKs); cancel stays an alias.
      if (params.children !== undefined && !['abort', 'keep', 'cancel'].includes(String(params.children)))
        throw new BadRequest('children is abort or keep');
      const fingerprint = canonical({ method: "abort", params });
      const previous = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (previous && previous.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("Request id reused with different input"),
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
      if (previous?.state === "completed") return previous;
      const stopped = await this.abortRequests(params.queued === 'keep' ? 'keep' : 'cancel', params.children === 'keep');
      await this.state();
      const record: RequestRecord = {
        id,
        method: "abort",
        fingerprint,
        state: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        outcome: { result: stopped },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    if (["status", "compact"].includes(String(request.method))) {
      object(request.params ?? {}, request.method === "status" ? [] : ["instructions"]);
      const pi = await this.harness.pi(),
        root = await pi.root(BACKGROUND_CONTEXT);
      if (request.method === "compact") {
        const params = object(request.params ?? {}, ["instructions"]);
        await pi.waitForTask(
          await root.compact(
            params.instructions as string | undefined,
            BACKGROUND_CONTEXT,
          ),
          BACKGROUND_CONTEXT,
        );
      }
      const record: RequestRecord = {
        id,
        method: String(request.method),
        fingerprint: canonical(request),
        state: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        outcome: {
          result:
            request.method === "status"
              ? {
                  ...(await this.activity()),
                  connected: this.attached.connected,
                }
              : { compacted: true },
        },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      return record;
    }
    if (request.method !== "prompt" && request.method !== "continue" && request.method !== 'steer')
      throw new BadRequest("Unsupported request method");
    const params = object(request.params, [
      "text",
      "allowDisconnected",
      "history",
      "metadata",
      "from",
      "attachments",
      "files",
      "images",
      "whileRunning",
      "output",
      "spendLimit",
      "runLimits",
      "actor",
      "bucket",
      "endUser",
    ]);
    const text =
      request.method === "continue"
        ? ""
        : (params.text === undefined || (typeof params.text === "string" && !params.text.trim() &&
            new TextEncoder().encode(params.text).length <= 6 * 1024 * 1024)) &&
            Array.isArray(params.files) && params.files.length > 0
          ? ""
        : boundedText(params.text, "text", 6 * 1024 * 1024);
    if (notice) {
      // An agent's message, and a child's ending sent at once (delegate.notify "asap"), join the running turn.
      params.whileRunning =
        notice.metadata.kind === "message" || (delivery?.run && delivery.steer) ? "steer" : "queue";
    } else {
      if (params.metadata !== undefined)
        params.metadata = metadataInput(params.metadata);
      if (params.from !== undefined) params.from = senderInput(params.from);
    }
    try {
      if (params.actor !== undefined) params.actor = actorInput(params.actor);
      if (params.bucket !== undefined)
        params.bucket = bucketInput(params.bucket);
      if (params.output !== undefined)
        params.output = outputInput(params.output);
      if (params.spendLimit !== undefined) {
        const usd = spendInput(params.spendLimit);
        params.spendLimit = usd === null ? null : { usd };
      }
      if (params.runLimits !== undefined) {
        const limits = runLimitsInput(params.runLimits);
        if (
          !limits ||
          Object.keys(limits).some(
            (key) => !["maxResponses", "maxSeconds"].includes(key),
          )
        )
          throw new Error(
            "runLimits is {maxResponses?, maxSeconds?} for a run",
          );
        params.runLimits = limits;
      }
    } catch (error) {
      throw new BadRequest((error as Error).message);
    }
    if (
      params.whileRunning !== undefined &&
      !["queue", "steer"].includes(String(params.whileRunning))
    )
      throw new BadRequest("Invalid whileRunning");
    if (
      params.history !== undefined &&
      !["none", "full"].includes(String(params.history))
    )
      throw new BadRequest("Invalid history");
    if (
      params.images !== undefined &&
      (!Array.isArray(params.images) || params.images.length > 8)
    )
      throw new BadRequest("At most eight image references per input");
    if (params.attachments !== undefined)
      throw new BadRequest(
        "Use file upload before prompting; attachment hydration is not implemented",
      );
    if (request.method === 'steer') params.whileRunning = 'steer';
    if (params.output !== undefined && params.whileRunning === "steer")
      throw new BadRequest("output is for a prompt that starts its own turn, not whileRunning: steer");
    const fingerprint = acceptedFingerprint ?? (
      params.files === undefined
        ? canonical({ method: request.method, params })
        : await digest(canonical({ method: request.method, params })));
    const old = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (old && old.fingerprint !== fingerprint)
      throw Object.assign(new Error("Request id reused with different input"), {
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
      });
    if (old?.state === "completed" || old?.accepted) return this.replayedRequest(old);
    if (!(notice && delivery && !delivery.run) && await this.ctx.storage.get(`cancelled-request:${id}`)) {
      if (old) return old;
      throw Object.assign(new Error("Request cancelled"), { status: 409, code: "aborted" });
    }
    if (!old && request.method !== "steer" && (await this.records()).filter(record => record.state !== "completed").length >= MAX_OPEN_REQUESTS)
      throw Object.assign(new Error("Too many requests queued for this agent"), { status: 429 });
    const conf = await this.config();
    if (params.endUser !== undefined) {
      if (request.method !== "prompt") throw new BadRequest("endUser is for a prompt");
      const { accounts } = await keyServices(this.env);
      await new EndUserCredits(accounts.db).requireExisting(conf.tenantId, params.endUser as string);
    }
    const requestedBucket = params.bucket as string | undefined;
    const effectiveBucket = requestedBucket ?? conf.config.bucket ?? await this.ctx.storage.get<string>("run-bucket") ?? "default";
    params.bucket = effectiveBucket;
    if (!old) await refreshIdleLifetime(this.env, this.ctx.storage, conf);
    if (conf.config.spendLimit) await this.flushBilling(true);
    if (notice) await this.delegation.landNotice(id, notice.costUsd, Array.isArray(notice.metadata.batch) ? notice.metadata.batch as { requestId: string; costUsd: number }[] : []);
    const spend = await this.agentSpend(conf);
    const refusal = agentSpendRefusal(conf.id, spend);
    if (refusal && !notice)
      throw Object.assign(new Error(refusal.error), {
        status: 402,
        code: "SPEND_LIMIT",
      });
    const endUserRefusal = await this.endUserLimit(conf, effectiveBucket, params.endUser as string | undefined);
    if (endUserRefusal) throw endUserRefusal;
    const pending = (await this.harness.pending()).find(
      (item) => item.status === "running",
    );
    // Pending operation receipts can outlive their native run. Only a live
    // turn can take a steer; its accepted steers remain part of that logical
    // turn when Pi drains them after a final answer.
    let candidate = params.whileRunning === 'steer' ? await this.runningRequest() : undefined;
    if (candidate && ((await this.ctx.storage.get<RequestRecord>(reqKey(candidate.owner)))?.params?.endUser ?? null) !== (params.endUser ?? null)) candidate = undefined;
    if (candidate && !await this.batchQueue.canSteer(params.endUser as string | undefined)) candidate = undefined;
    const running = old?.steerCommitted ? old.steeredInto : candidate?.owner;
    const messageWake = async () => {
      const wake = notice!.root === conf.id
        ? await this.admitDelegateWake(id)
        : await this.env.AGENTS.getByName(notice!.root).admitDelegateWake(id);
      return wake.allowed ? undefined : { error: `This agent's chain has had ${this.delegateWakeLimit ? Number(this.delegateWakeLimit) : MULTI_AGENT_LIMITS.wakesPerHour} turns started by sub-agent notifications and messages this hour, its limit: the message is in its history, but no turn ran. Send a message to go on`, code: 'agent_loop_limit', stopped: 'agent_loop_limit' };
    };
    const noTurn = notice
      ? refusal ?? (delivery && !delivery.run ? { error: delivery.message, code: delivery.stopped, stopped: delivery.stopped } : undefined)
      : undefined;
    await this.requireApplication(params.allowDisconnected);
    const preparing = params.files !== undefined && !old?.admitted && !(delivery && !delivery.run && notice);
    if (preparing) {
      await this.promptPreparations.begin({ tenant: conf.tenantId, agent: conf.id, requestId: id, fingerprint }, () => this.admitRequest(conf, id, params.bucket as string | undefined, params.endUser as string | undefined));
      await this.arm();
    }
    let files: Awaited<ReturnType<PromptAttachments["attach"]>> | undefined;
    try {
    const audioRunLimit = (params.spendLimit as { usd?: number } | undefined)?.usd;
    const audioBudget = params.files === undefined ? Infinity : Math.min(
      spend ? Math.max(0, spend.usd - spend.spent) : Infinity,
      audioRunLimit === undefined ? Infinity : Math.max(0,
        audioRunLimit - await withSql(this.env, sql => runSpend(sql, conf.tenantId, conf.id, id)) - await this.delegation.cost(id)),
    );
    files =
      params.files === undefined
        ? undefined
        : await this.promptAttachments.attach(
            {
              tenant: conf.tenantId,
              agent: conf.id,
              requestId: id,
              mounts: (conf.config.mounts ?? []) as Mount[],
              spendLimit: (params.spendLimit as { usd?: number } | undefined)?.usd,
              ...(Number.isFinite(audioBudget) ? { budget: audioBudget } : {}),
              keyScope: conf.config.keyScope,
              identity: { subject: (params.endUser as string | undefined) ?? conf.config.subject, context: conf.config.context },
              actor: params.actor as string | undefined,
              bucket: (params.bucket as string | undefined) ?? conf.config.bucket,
            },
            params.files,
          );
    if (request.method !== "continue" && !text.trim() && !files?.some(file => file.transcript))
      throw new BadRequest("Give the agent some text, or audio to transcribe");
    if (!noTurn && await this.ctx.storage.get(`cancelled-request:${id}`))
      throw Object.assign(new Error("Request cancelled"), { status: 409, code: "aborted" });
    if (files) params.files = attachmentFiles(files);
    } catch (error) {
      if (preparing) await this.promptPreparations.fail(id);
      throw error;
    }
    if (request.method === "prompt" && !notice && !old?.accepted)
      await this.closeHumanInputs("superseded");
    const record: RequestRecord = old && !old.noticeQueued ? old : {
      id,
      method: String(request.method),
      billing: {
        tenantId: conf.tenantId,
        agentId: conf.id,
        model: conf.config.model,
      },
      params,
      ...(typeof params.endUser === "string" ? { endUser: params.endUser } : {}),
      agentSpendAt: spend?.setAt ?? null,
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      ...((params.actor ?? (params.from as { id?: string } | undefined)?.id) ? { actor: String(params.actor ?? (params.from as { id: string }).id) } : {}),
      fingerprint,
      state: pending ? "queued" : "running",
      ...(params.whileRunning === "steer"
        ? running
          ? { steer: "accepted" as const, ...(notice?.metadata.kind === 'message' ? {} : { steeredInto: running, steerCommitted: true as const }) }
          : { steer: "queued" as const }
        : {}),
      startedAt: old?.startedAt ?? Date.now(),
    };
    delete record.noticeQueued;
    const prompt = files
      ? attachmentInput(text, files)
      : params.images
        ? imageReferenceInput(text, params.images as ImageRef[], conf.tenantId)
        : text;
    const configurationWait = record.configurationWait ?? await this.configurationQueue.pendingOrder();
    if (configurationWait > await this.configurationQueue.completedOrder()) {
      if (preparing) { record.admitted = true; await this.promptPreparations.finish(id); }
      record.configurationWait = configurationWait;
      record.state = 'queued';
      record.configurationWaitSequence = await this.ctx.storage.transaction(async tx => {
        let sequence = record.configurationWaitSequence ?? (await tx.get<RequestRecord>(reqKey(id)))?.configurationWaitSequence;
        if (sequence === undefined) {
          sequence = (await tx.get<number>('configuration-wait-order') ?? 0) + 1;
          await tx.put('configuration-wait-order', sequence);
        }
        const saved = { ...record, configurationWaitSequence: sequence };
        await tx.put(reqKey(id), saved);
        return sequence;
      });
      await this.arm(Date.now() + 1000);
      return record;
    }
    delete record.configurationWait;
    delete record.configurationWaitSequence;
    record.state = running ? 'queued' : 'running';
    if (preparing) record.admitted = true;
    await this.ctx.storage.put(reqKey(id), record);
    if (preparing) await this.promptPreparations.finish(id);
    const landWithoutTurn = async (stop: { error: string; code?: string; stopped?: string }) => {
      const pi = await this.harness.pi(),
        root = await pi.root(BACKGROUND_CONTEXT);
      const saved = await root.submit(
        {
          type: "write",
          requestId: id,
          entry: {
            kind: "camel.prompt",
            data: { requestId: id, ...notice, ...(params.whileRunning === 'steer' ? { logicalOwner: null } : {}) } as never,
            model: [
              { role: "user", content: text, timestamp: Date.now() },
            ] as never,
          },
        },
        BACKGROUND_CONTEXT,
      );
      await saved.wait(BACKGROUND_CONTEXT);
      record.state = "completed";
      record.status = "failed";
      delete record.steeredInto;
      delete record.steerCommitted;
      if (params.whileRunning === 'steer') record.steer = 'queued';
      record.endedAt = Date.now();
      record.outcome = {
        result: { ...stop, usage: this.usageView(await this.usageForRequest(id)) },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await this.emit({ type: "response", id, outcome: record.outcome });
      if (record.admitted) {
        await releaseTurn(this.env, conf.tenantId, conf.id, id);
        await this.env.TENANTS.getByName(conf.tenantId).release(`${conf.id}:${id}`);
      }
      return record;
    };
    if (noTurn && notice) return landWithoutTurn(noTurn);
    await this.arm(Date.now() + 1000);
    if (!record.admitted) {
      await this.admitRequest(conf, id, params.bucket as string | undefined, params.endUser as string | undefined);
      record.admitted = true;
    }
    await this.ctx.storage.put(reqKey(id), record);
    await this.observe();
    // Attachment changes take effect on the next turn, including inherited ones.
    await this.refreshComputerTools();
    // No successful acceptance response until Pi has durably recorded the input.
    if (request.method === "continue")
      await this.harness.continue({ operationId: id });
    else {
      // Legacy steers held for the next prompt (`held-steer:`) go in with it, once: a marker names the prompt they went in
      // with before its commit, so one that committed and was lost before they were removed is not appended twice.
      const taking = await this.ctx.storage.get<{ request: string; keys: string[] }>('held-steer-taking');
      if (taking) {
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        if (await root.commit(async tx => !!(await tx.submissionByRequest(root.id, taking.request)), BACKGROUND_CONTEXT)) await this.ctx.storage.delete(taking.keys);
        await this.ctx.storage.delete('held-steer-taking');
      }
      const held = !pending ? new Map([...(await this.ctx.storage.list<{ id: string; prompt: typeof prompt; endUser?: string; startedAt: number }>({ prefix: 'held-steer:' }))].filter(([, steer]) => (steer.endUser ?? null) === (params.endUser ?? null))) : new Map();
      const submission = {
        operationId: id,
        whenBusy: params.whileRunning === "steer" && running ? "steer" as const : "followUp" as const,
        entry: {
          kind: record.steeredInto ? "camel.steer" : "camel.prompt",
          data: {
            requestId: id,
            ...((notice?.metadata ?? params.metadata)
              ? { metadata: notice?.metadata ?? params.metadata }
              : {}),
            ...(params.from ? { from: params.from } : {}),
            ...(notice ? { source: notice.source } : {}),
          } as never,
        },
      };
      // A steer the running turn takes and an agent's message join a turn already going; anything else may be held for
      // a batch, so Pi's inbox only holds prompts that may share a turn (batch-queue.ts).
      const holding = running || notice?.metadata.kind === 'message' ? false
        : await this.batchQueue.holds(conf, { id, ...(record.actor ? { actor: record.actor } : {}), bucket: effectiveBucket, params }, notice !== undefined);
      if (holding) {
        const accepted = await this.batchQueue.hold(record, prompt, submission, holding === "window");
        if (requestedBucket !== undefined && params.endUser === undefined) await this.ctx.storage.put("run-bucket", requestedBucket);
        await this.arm();
        return accepted;
      }
      if (held.size) await this.ctx.storage.put('held-steer-taking', { request: id, keys: [...held.keys()] });
      if (notice?.metadata.kind === 'message') {
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        const input = { requestId: id, content: prompt, entry: submission.entry, candidate, held: [...held.values()],
          ...(record.steerCommitted ? { legacyOwner: record.steeredInto } : {}) };
        // The candidate is only a hint until this transaction queues its input.
        // If its turn ended meanwhile, take a wake before exposing an own turn.
        let admitted = await admitAgentMessage(root, input, 'join');
        if (!admitted.submitted) {
          const refusal = await messageWake();
          if (refusal) return landWithoutTurn(refusal);
          // A turn of its own is a follow-up: held while follow-ups wait that it may not join (batch-queue.ts).
          if (await this.batchQueue.holds(conf, { id, params }, true)) {
            if (held.size) await this.ctx.storage.delete('held-steer-taking');
            const owned = await this.batchQueue.hold(record, prompt, { operationId: id, whenBusy: "followUp",
              entry: { kind: "camel.prompt", data: { ...(submission.entry.data as Record<string, unknown>), logicalOwner: null } } }, false);
            await this.steeringOwner(owned, null);
            await this.arm();
            return (await this.ctx.storage.get<RequestRecord>(reqKey(id))) ?? owned;
          }
          admitted = await admitAgentMessage(root, input, 'own');
        }
        if (admitted.submitted && admitted.owner !== undefined) {
          const latest = (await this.ctx.storage.get<RequestRecord>(reqKey(id))) ?? record;
          await this.steeringOwner(latest, admitted.owner);
        }
        if (held.size) await this.ctx.storage.delete([...held.keys(), 'held-steer-taking']);
      } else if (!held.size) await this.harness.submit(prompt, submission);
      else {
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        await root.commit(async tx => {
          if (await tx.submissionByRequest(root.id, id)) return;
          await root.submit(tx, { type: 'input', requestId: id, content: prompt, whenBusy: submission.whenBusy, entry: submission.entry });
          for (const value of [...held.values()].sort((a, b) => a.startedAt - b.startedAt))
            await tx.appendEntry(root.id, { kind: 'camel.steer', data: { requestId: value.id }, model: [{ role: 'user', content: value.prompt, timestamp: Date.now() }] });
        }, BACKGROUND_CONTEXT);
        await this.ctx.storage.delete([...held.keys(), 'held-steer-taking']);
      }
    }
    const accepted = await this.ctx.storage.transaction(async (tx) => {
      const latest = (await tx.get<RequestRecord>(reqKey(id))) ?? record;
      const accepted = { ...latest, accepted: true };
      await tx.put(reqKey(id), accepted);
      if (requestedBucket !== undefined && params.endUser === undefined) await tx.put("run-bucket", requestedBucket);
      return accepted;
    });
    this.track(id);
    await this.arm();
    return accepted;
  }
