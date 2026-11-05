import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { startFixture } from "./fixture.ts";

test(
  "optional native Container and Sandbox SDK providers in local Docker",
  { timeout: 240_000 },
  async (t) => {
    const fixture = await startFixture({ config: "wrangler.computers.test.jsonc" });
    const { worker: server, token } = fixture;
    t.after(async () => {
      // Native Container local emulation can leave its Docker network proxy up
      // after destroy(). Remove only containers named in this test's own log.
      const names = new Set(
        [
          ...server
            .logs()
            .matchAll(
              /containerName = (workerd-camelrun-proto-workers-computers-local-(?:ContainerComputer|SandboxComputer)-[a-f0-9]{64})/g,
            ),
        ].map((match) => match[1]),
      );
      await fixture.stop();
      for (const name of names) {
        for (const target of [name, `${name}-proxy`]) {
          try {
            await promisify(execFile)("docker", ["rm", "-f", target], {
              timeout: 10000,
            });
          } catch (error) {
            if (
              !String((error as { stderr?: string }).stderr).includes(
                "No such container",
              )
            )
              throw error;
          }
        }
      }
    });
    try {
      const create = await fetch(`${server.url}/v1/agents`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test/echo" }),
      });
      assert.equal(create.status, 201, await create.clone().text());
      const { id } = (await create.json()) as { id: string };
      const call = async (
        provider: string,
        request: object,
        expectedStatus = 200,
      ) => {
        const response = await fetch(
          `${server.url}/experimental/agents/${id}/computer`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ provider, ...request }),
            signal: AbortSignal.timeout(60000),
          },
        );
        if (response.status !== 200)
          await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(
          response.status,
          expectedStatus,
          `${await response.clone().text()}\n${server.logs()}`,
        );
        return (await response.json()) as Record<string, any>;
      };
      for (const provider of ["container", "sandbox"])
        await t.test(provider, async (t) => {
          const start = performance.now();
          const result = await call(provider, {
            op: "exec",
            argv: ["node", "-e", "console.log('local Linux')"],
          });
          assert.equal(result.exitCode, 0);
          assert.match(result.stdout, /local Linux/);
          t.diagnostic(
            `cold_start_ms=${Math.round(performance.now() - start)}`,
          );
          await call(provider, {
            op: "write",
            path: "test.txt",
            content: "persistent snapshot content",
          });
          assert.equal(
            (await call(provider, { op: "read", path: "test.txt" })).content,
            "persistent snapshot content",
          );
          // Traverse the actual model -> codemode -> registered computer tool path.
          const requestId = `nested-${provider}`;
          const submit = await fetch(`${server.url}/clients/${id}/requests`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              id: requestId,
              method: "prompt",
              params: {
                text: `code:text(await tools.computer({provider:"${provider}",op:"exec",argv:["node","-e","console.log('nested computer')"]}));`,
              },
            }),
          });
          assert.equal(submit.status, 202, await submit.text());
          const settled = await fetch(
            `${server.url}/clients/${id}/requests/${requestId}?wait=20`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          const record = (await settled.json()) as any;
          assert.equal(record.status, "completed", JSON.stringify(record));
          assert.match(record.outcome.result.reply, /nested computer/);
          await call(provider, {
            op: "write",
            path: "table.csv",
            content: '"a,b",c\r\n"d""e",f\n',
          });
          const parsedCsv = await call(provider, {
            op: "parse",
            path: "table.csv",
            format: "csv",
          });
          assert.equal(parsedCsv.text, 'a,b\tc\nd"e\tf');
          assert.equal(parsedCsv.truncated, false);
          await call(provider, {
            op: "write",
            path: "page.html",
            content:
              "<h1>Title</h1><script>danger()</script><p>Hello &amp; world</p>",
          });
          const parsedHtml = await call(provider, {
            op: "parse",
            path: "page.html",
            format: "html",
          });
          assert.equal(parsedHtml.text, "Title\nHello & world");
          await call(provider, {
            op: "write",
            path: "object.json",
            content: '{"answer":42}',
          });
          assert.match(
            (
              await call(provider, {
                op: "parse",
                path: "object.json",
                format: "json",
              })
            ).text,
            /"answer": 42/,
          );
          if (provider === "container") {
            await call(provider, {
              op: "exec",
              argv: [
                "node",
                "-e",
                "require('node:fs').writeFileSync('/workspace/large.txt','a'.repeat(100000))",
              ],
            });
            const bounded = await call(provider, {
              op: "parse",
              path: "large.txt",
              format: "text",
            });
            assert.equal(bounded.truncated, true);
            assert.ok(bounded.text.length <= 60000);
            await call(provider, {
              op: "exec",
              argv: [
                "node",
                "-e",
                "require('node:fs').writeFileSync('/workspace/over.txt','a'.repeat(8*1024*1024+1))",
              ],
            });
            await call(
              provider,
              { op: "parse", path: "over.txt", format: "text" },
              500,
            );
          }

          const network = await call(provider, {
            op: "exec",
            argv: [
              "node",
              "-e",
              "fetch('https://example.com',{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(3)).catch(()=>console.log('blocked'))",
            ],
          });
          assert.equal(network.exitCode, 0);
          assert.match(network.stdout, /blocked/);
          await call(provider, { op: "snapshot", name: "saved" });
          await call(provider, {
            op: "write",
            path: "test.txt",
            content: "modified",
          });
          await call(provider, { op: "sleep" });
          const resume = performance.now();
          await call(provider, { op: "restore", name: "saved" });
          assert.equal(
            (await call(provider, { op: "read", path: "test.txt" })).content,
            "persistent snapshot content",
          );
          t.diagnostic(
            `restore_and_read_ms=${Math.round(performance.now() - resume)}`,
          );
          await call(provider, { op: "sleep" });
        });
    } catch (error) {
      t.diagnostic(server.logs());
      throw error;
    }
  },
);
