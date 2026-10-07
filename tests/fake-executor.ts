import type { CodeExecutor, Guest } from "../src/codemode.ts";
import type { WireMessage } from "../src/protocol.ts";

/**
 * A CodeExecutor that runs in this process, speaking v8-exec's wire, with the latency and failures a test chooses. Its
 * "code" is a script, a step per line:
 * - `tool <name> <json args>` calls a tool and keeps its result;
 * - `print <text>` writes output;
 * - `sleep <ms>` waits;
 * - `crash` ends the guest as a killed process would;
 * - `return <json>` ends with that value (else it returns the last tool result).
 * `latencyMs` delays the start of each execution; `opened` counts executions.
 */
export function fakeExecutor(options: { latencyMs?: number } = {}): CodeExecutor & { opened: number } {
  const executor = {
    opened: 0,
    open(): Guest {
      executor.opened++;
      let deliver: (message: unknown) => void = () => {};
      let closed: (reason: string) => void = () => {};
      let ended = false;
      let calls = 0;
      const answers = new Map<string, (message: WireMessage) => void>();
      const call = (name: string, args: unknown) => new Promise<string>((resolve, reject) => {
        const id = `call_${++calls}`;
        answers.set(id, answer => answer.type === "response" && answer.error === undefined ? resolve(answer.result) : reject(new Error((answer as { error?: string }).error)));
        deliver({ type: "request", id, method: "tool", params: { name, args } });
      });
      const run = async (id: string, code: string) => {
        if (options.latencyMs) await new Promise(resolve => setTimeout(resolve, options.latencyMs));
        const output: string[] = [];
        let value: unknown;
        for (const line of code.split("\n").map(step => step.trim()).filter(Boolean)) {
          if (ended) return;
          const [step, ...rest] = line.split(" ");
          const argument = rest.join(" ");
          if (step === "tool") { const [name, ...json] = rest; value = JSON.parse(await call(name, JSON.parse(json.join(" ") || "{}"))); }
          else if (step === "print") { output.push(argument); deliver({ type: "event", event: { type: "output", text: argument } }); }
          else if (step === "sleep") await new Promise(resolve => setTimeout(resolve, Number(argument)));
          else if (step === "crash") return closed("Codemode sandbox process exited (SIGKILL)");
          else if (step === "return") value = JSON.parse(argument);
          else return deliver({ type: "response", id, error: `Unknown step: ${step}` });
        }
        output.push(JSON.stringify(value ?? null));
        deliver({ type: "response", id, result: { output, truncated: false, returned: { index: output.length - 1, json: true, truncated: false } } });
      };
      return {
        dispatched: true,
        send(message) {
          if (ended) return;
          if (message.type === "request" && message.method === "execute") void run(message.id, String(message.params.code)).catch(error => deliver({ type: "response", id: message.id, error: String(error) }));
          else if (message.type === "response") answers.get(message.id)?.(message);
        },
        listen(onMessage, onClose) { deliver = onMessage; closed = onClose; },
        end() { ended = true; },
      };
    },
  };
  return executor;
}
