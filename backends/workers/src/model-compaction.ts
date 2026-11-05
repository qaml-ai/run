import { CompactionTask, GenerationTask, type AnyTask, type CompactionSettings, type RegistryReader, type RegistrySnapshot } from "@earendil-works/pi-durable";

/** Measure the system message at the same boundary where Pi selects a compaction prefix. */
export function withCompactionPrompt(registry: RegistryReader, policy: (fixedTokens: number) => CompactionSettings | undefined): RegistryReader {
  const wrap = (task: AnyTask, phase: string): AnyTask => {
    const definition = task.definition;
    const original = definition.phases[phase];
    return { definition: { ...definition, phases: { ...definition.phases, [phase]: async (record: any, runtime: any, context: any) => {
      const view = await runtime.context(runtime.conversationId, context);
      const system = view.messages.findLast((message: { role: string }) => message.role === "system");
      const fixedTokens = system ? Math.ceil(JSON.stringify(system).length / 4) : 0;
      const settings = { ...runtime.settings, compaction: policy(fixedTokens) ?? runtime.settings.compaction };
      const measured = new Proxy(runtime, { get(target, key) {
        if (key === "settings") return settings;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      return original(record, measured, context);
    } } } };
  };
  const tasks = new Map([
    [GenerationTask.definition.name, wrap(GenerationTask, "prepare")],
    [CompactionTask.definition.name, wrap(CompactionTask, "select")],
  ]);
  return {
    subscribe: listener => registry.subscribe(listener),
    snapshot: () => {
      const snapshot = registry.snapshot();
      return new Proxy(snapshot, { get(target, key) {
        if (key === "task") return (name: string) => tasks.get(name) ?? target.task(name);
        if (key === "tasks") return () => target.tasks().map(task => tasks.get(task.definition.name) ?? task);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } }) as RegistrySnapshot;
    },
  };
}
