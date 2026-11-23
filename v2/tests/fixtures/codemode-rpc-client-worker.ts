import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
  type CodemodeTool,
} from "@earendil-works/pi-codemode/portable";

interface TestEnv {
  CODEMODE_SANDBOX: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "codemode-rpc-test-client" });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const body = (await request.json()) as {
        code: string;
        instanceName?: string;
        interruptBudget?: number;
        timeoutMs?: number;
      };

      const calls: Array<{ name: string; args: unknown }> = [];
      const tools: CodemodeTool[] = [
        {
          name: "add",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
          execute: async (args) => {
            calls.push({ name: "add", args });
            const { a, b } = args as { a: number; b: number };
            return { sum: a + b };
          },
        },
        {
          name: "greet",
          description: "Greet a user by name",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
          },
          execute: async (args) => {
            calls.push({ name: "greet", args });
            const { name } = args as { name: string };
            return `Hello, ${name}!`;
          },
        },
      ];

      const sandbox = new RemoteCodemodeSandbox({
        remote: () =>
          env.CODEMODE_SANDBOX.getByName(
            body.instanceName || "test-session",
          ) as unknown as CodemodeRemote,
        tools,
        interruptBudget: body.interruptBudget ?? 200_000,
        timeoutMs: body.timeoutMs ?? 15_000,
      });

      try {
        const result = await sandbox.execute(body.code);
        return Response.json({ result, calls });
      } finally {
        await sandbox.close();
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
