import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import {
  assertSafeBrowserUrl,
  assertScreenshotPathExtension,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_SCHEMAS,
  BrowserBlockedUrlError,
  browserExtract,
  browserMarkdown,
  browserScreenshot,
  browserSnapshot,
  executeBrowserTool,
  isBrowserToolName,
  resolveBrowserEngine,
  type BrowserEnv,
} from "../worker/src/browser.ts";
import { CamelFsClient, normalizeRepoPath } from "../worker/src/camelfs.ts";
import { storeToolImages } from "../worker/src/tool-images.ts";

// Valid 2x1 PNG fixture (same verified fixture used in svg-renderer.test.ts)
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC";
const VALID_PNG_BYTES = Buffer.from(VALID_PNG_BASE64, "base64");

test("assertSafeBrowserUrl blocks non-http(s), credentials, internal hosts, and private/metadata IPs", () => {
  const blocked = [
    "",
    "not a url",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<h1>hi</h1>",
    "ftp://example.com/file",
    "chrome://settings",
    "https://user:pass@example.com/",
    "http://localhost/",
    "http://localhost:8787/admin",
    "https://sub.localhost/",
    "http://camelfsd:8790/v1/repos",
    "http://metadata/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://service.internal/",
    "http://printer.local/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.170.2/v2/credentials",
    "http://0.0.0.0/",
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[64:ff9b::10.0.0.1]/",
    "http://[2002:7f00:0001::1]/",
  ];

  for (const url of blocked) {
    assert.throws(
      () => assertSafeBrowserUrl(url),
      BrowserBlockedUrlError,
      `Expected URL to be blocked: ${url}`,
    );
  }

  const allowed = [
    "https://example.com/docs?q=1#top",
    "http://example.org/page",
    "https://93.184.216.34/",
    "https://[2606:2800:220:1:248:1893:25c8:1946]/",
  ];

  for (const url of allowed) {
    const parsed = assertSafeBrowserUrl(url);
    assert.ok(parsed.protocol === "http:" || parsed.protocol === "https:");
  }
});

test("resolveBrowserEngine defaults to kitesurf, respects env default, and validates explicit engine", () => {
  assert.equal(resolveBrowserEngine(undefined), "kitesurf");
  assert.equal(resolveBrowserEngine(undefined, { BROWSER_DEFAULT_ENGINE: "chromium" }), "chromium");
  assert.equal(resolveBrowserEngine("kitesurf", { BROWSER_DEFAULT_ENGINE: "chromium" }), "kitesurf");
  assert.equal(resolveBrowserEngine("chromium"), "chromium");
  assert.throws(() => resolveBrowserEngine("firefox"), /Invalid browser engine/);
});

test("Workers binding quickAction sends browser: 'kitesurf' by default and omits browser for chromium", async () => {
  const calls: Array<{ action: string; options: Record<string, unknown> }> = [];
  const env: BrowserEnv = {
    BROWSER: {
      quickAction: async (action: string, options: Record<string, unknown>) => {
        calls.push({ action, options });
        return new Response(
          JSON.stringify({
            success: true,
            result: "# Example Domain\n\nRendered via Cloudflare Browser Run.",
            meta: { status: 200, title: "Example Domain", finalUrl: "https://example.com/" },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-browser-ms-used": "42",
            },
          },
        );
      },
    } as unknown as BrowserRun,
  };

  const kitesurfRes = await browserMarkdown(env, {
    url: "https://example.com",
    waitUntil: "networkidle2",
    waitForSelector: "main",
    timeoutMs: 15_000,
  });
  assert.equal(kitesurfRes.engine, "kitesurf");
  assert.equal(kitesurfRes.title, "Example Domain");
  assert.equal(kitesurfRes.status, 200);
  assert.equal(kitesurfRes.browserMsUsed, 42);
  assert.equal(kitesurfRes.truncated, false);
  assert.match(kitesurfRes.markdown, /# Example Domain/);
  assert.equal(calls[0]?.action, "markdown");
  assert.equal(calls[0]?.options.browser, "kitesurf");
  assert.deepEqual(calls[0]?.options.gotoOptions, { waitUntil: "networkidle2", timeout: 15_000 });
  assert.deepEqual(calls[0]?.options.waitForSelector, { selector: "main", timeout: 15_000 });

  // Chromium omits `browser` because Cloudflare rejects any value other than "kitesurf"
  const chromiumRes = await browserMarkdown(env, {
    url: "https://example.com",
    engine: "chromium",
    maxChars: 200,
  });
  assert.equal(chromiumRes.engine, "chromium");
  assert.equal("browser" in (calls[1]?.options ?? {}), false);
});

test("blocks redirect to private metadata IP reported in meta.finalUrl", async () => {
  const env: BrowserEnv = {
    BROWSER: {
      quickAction: async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: "secret metadata",
            meta: { status: 200, title: "meta", finalUrl: "http://169.254.169.254/latest/meta-data/" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    } as unknown as BrowserRun,
  };

  await assert.rejects(
    browserMarkdown(env, { url: "https://example.com/redirect-me" }),
    BrowserBlockedUrlError,
  );
});

test("REST API fallback uses ?browser=kitesurf, Bearer auth, omits browser in body, and refuses redirects", async () => {
  const requests: Array<{ url: string; method?: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const env: BrowserEnv = {
    CLOUDFLARE_ACCOUNT_ID: "acct_123",
    CLOUDFLARE_BROWSER_RUN_TOKEN: "cf_token_test",
    CLOUDFLARE_BROWSER_RUN_BASE_URL: "https://api.cloudflare.test/client/v4",
  };

  const res = await browserMarkdown(
    env,
    { url: "https://example.com/docs" },
    {
      fetchFn: async (input, init) => {
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        requests.push({
          url: String(input),
          method: init?.method,
          headers,
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        assert.equal(init?.redirect, "manual");
        return new Response(
          JSON.stringify({
            success: true,
            result: "# Docs",
            meta: { status: 200, title: "Docs" },
          }),
          { status: 200, headers: { "content-type": "application/json", "x-browser-ms-used": "19" } },
        );
      },
    },
  );

  assert.equal(res.markdown, "# Docs");
  assert.equal(res.browserMsUsed, 19);
  assert.equal(
    requests[0]?.url,
    "https://api.cloudflare.test/client/v4/accounts/acct_123/browser-run/markdown?browser=kitesurf",
  );
  assert.equal(requests[0]?.headers.authorization, "Bearer cf_token_test");
  assert.equal("browser" in (requests[0]?.body ?? {}), false);

  // Chromium omits ?browser=kitesurf query param
  await browserMarkdown(
    env,
    { url: "https://example.com/docs", engine: "chromium" },
    {
      fetchFn: async (input) => {
        assert.equal(String(input), "https://api.cloudflare.test/client/v4/accounts/acct_123/browser-run/markdown");
        return new Response(JSON.stringify({ success: true, result: "ok", meta: { status: 200, title: "ok" } }));
      },
    },
  );

  // Refuses HTTP 302 redirect so Bearer token cannot leak
  await assert.rejects(
    browserMarkdown(
      env,
      { url: "https://example.com/docs" },
      {
        fetchFn: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
      },
    ),
    /fetch failed/,
  );

  // Missing both binding and REST credentials returns 503 ApiError
  await assert.rejects(
    browserMarkdown({}, { url: "https://example.com" }),
    /Cloudflare Browser Run is not configured/,
  );
});

test("browserScreenshot validates binary PNG and propagates BrowserRunErrorResponse", async () => {
  const seen: Array<{ action: string; options: Record<string, unknown> }> = [];
  const env: BrowserEnv = {
    BROWSER: {
      quickAction: async (action: string, options: Record<string, unknown>) => {
        seen.push({ action, options });
        return new Response(new Uint8Array(VALID_PNG_BYTES), {
          status: 200,
          headers: { "content-type": "image/png", "x-browser-ms-used": "65" },
        });
      },
    } as unknown as BrowserRun,
  };

  const shot = await browserScreenshot(env, {
    url: "https://example.com",
    fullPage: true,
    selector: "#hero",
    viewport: { width: 1024, height: 600 },
  });
  assert.equal(shot.contentType, "image/png");
  assert.equal(shot.width, 2);
  assert.equal(shot.height, 1);
  assert.equal(shot.base64, VALID_PNG_BASE64);
  assert.equal(shot.browserMsUsed, 65);
  assert.equal(seen[0]?.action, "screenshot");
  assert.equal(seen[0]?.options.browser, "kitesurf");
  assert.equal(seen[0]?.options.selector, "#hero");
  assert.deepEqual(seen[0]?.options.viewport, { width: 1024, height: 600 });
  assert.deepEqual(seen[0]?.options.screenshotOptions, { type: "png", fullPage: true });

  // Propagates Cloudflare BrowserRunErrorResponse cleanly
  const failingEnv: BrowserEnv = {
    BROWSER: {
      quickAction: async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 2012, message: "Navigation timed out", detail: "exceeded 30000ms" }],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    } as unknown as BrowserRun,
  };

  await assert.rejects(
    browserScreenshot(failingEnv, { url: "https://example.com" }),
    /\[2012\] Navigation timed out \(exceeded 30000ms\)/,
  );
});

test("browserSnapshot handles multi-format snapshot + single-format delegation, and browserExtract handles all 4 modes", async () => {
  const actions: string[] = [];
  const env: BrowserEnv = {
    BROWSER: {
      quickAction: async (action: string, options: Record<string, unknown>) => {
        actions.push(action);
        if (action === "snapshot") {
          assert.deepEqual(options.formats, ["markdown", "accessibilityTree", "screenshot"]);
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                markdown: "# Snap Title",
                accessibilityTree: { role: "RootWebArea", name: "Snap Title", children: [] },
                screenshot: VALID_PNG_BASE64,
              },
              meta: { status: 200, title: "Snap Title" },
            }),
            { status: 200, headers: { "content-type": "application/json", "x-browser-ms-used": "88" } },
          );
        }
        if (action === "markdown") {
          return new Response(
            JSON.stringify({ success: true, result: "Single format md", meta: { status: 200, title: "One" } }),
          );
        }
        if (action === "scrape") {
          assert.deepEqual(options.elements, [{ selector: "h1" }, { selector: "a" }]);
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ selector: "h1", results: [{ text: "Hello", html: "<h1>Hello</h1>", width: 100, height: 20, top: 0, left: 0, attributes: [] }] }],
              meta: { status: 200, title: "Scrape" },
            }),
          );
        }
        if (action === "links") {
          assert.equal(options.visibleLinksOnly, true);
          assert.equal(options.excludeExternalLinks, true);
          return new Response(
            JSON.stringify({
              success: true,
              result: ["https://example.com/a", "https://example.com/b"],
              meta: { status: 200, title: "Links" },
            }),
          );
        }
        if (action === "content") {
          return new Response(
            JSON.stringify({
              success: true,
              result: "<html><body>Hello</body></html>",
              meta: { status: 200, title: "HTML" },
            }),
          );
        }
        if (action === "accessibilityTree") {
          assert.equal(options.root, "main");
          assert.equal(options.interestingOnly, false);
          return new Response(
            JSON.stringify({
              success: true,
              result: { accessibilityTree: { role: "main", name: "Content" } },
              meta: { status: 200, title: "AX" },
            }),
          );
        }
        throw new Error(`unexpected action: ${action}`);
      },
    } as unknown as BrowserRun,
  };

  const snap = await browserSnapshot(env, {
    url: "https://example.com",
    formats: ["markdown", "accessibilityTree", "screenshot"],
  });
  assert.equal(snap.markdown, "# Snap Title");
  assert.equal(snap.accessibilityTree?.role, "RootWebArea");
  assert.equal(snap.screenshot?.width, 2);

  // Single-format snapshot delegates to dedicated markdown action (Cloudflare /snapshot requires >=2)
  const singleSnap = await browserSnapshot(env, {
    url: "https://example.com",
    formats: ["markdown"],
  });
  assert.equal(singleSnap.markdown, "Single format md");

  const scraped = await browserExtract(env, { url: "https://example.com", selectors: ["h1", "a"] });
  assert.equal(scraped.mode, "scrape");
  assert.equal((scraped.data as Array<{ selector: string }>)[0]?.selector, "h1");

  const links = await browserExtract(env, {
    url: "https://example.com",
    mode: "links",
    visibleLinksOnly: true,
    excludeExternalLinks: true,
  });
  assert.deepEqual(links.data, ["https://example.com/a", "https://example.com/b"]);

  const content = await browserExtract(env, { url: "https://example.com", mode: "content" });
  assert.equal(content.data, "<html><body>Hello</body></html>");

  const ax = await browserExtract(env, {
    url: "https://example.com",
    mode: "accessibilityTree",
    root: "main",
    interestingOnly: false,
  });
  assert.deepEqual(ax.data, { role: "main", name: "Content" });

  assert.deepEqual(actions, ["snapshot", "markdown", "scrape", "links", "content", "accessibilityTree"]);
});

test("builtins: ['browser'] schemas, inline image storage, and CamelFS screenshot persistence", async () => {
  assert.deepEqual([...BROWSER_TOOL_NAMES], [
    "browser_markdown",
    "browser_screenshot",
    "browser_snapshot",
    "browser_extract",
  ]);
  assert.deepEqual(
    BROWSER_TOOL_SCHEMAS.map((s) => s.name),
    [...BROWSER_TOOL_NAMES],
  );
  assert.equal(isBrowserToolName("browser_markdown"), true);
  assert.equal(isBrowserToolName("web_fetch"), false);

  // Verify pi/extensions.ts registers `BROWSER_TOOL_SCHEMAS` and dispatches `executeBrowserTool`
  const extensionsSource = readFileSync(new URL("../worker/src/pi/extensions.ts", import.meta.url), "utf8");
  assert.match(extensionsSource, /BROWSER_TOOL_SCHEMAS\.map/);
  assert.match(extensionsSource, /executeBrowserTool\(/);

  // Spin up a lightweight local mock CamelFS server to verify repo writes end-to-end
  const writtenPuts: Array<{ path: string; base64?: string }> = [];
  const cfsServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      puts?: Array<{ path: string; base64?: string }>;
    };
    if (body.puts) writtenPuts.push(...body.puts);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        commit: "abc123commit",
        tree: "tree123",
        changed: (body.puts ?? []).map((p) => p.path),
        totalBytes: VALID_PNG_BYTES.byteLength,
      }),
    );
  });

  await new Promise<void>((resolve) => cfsServer.listen(0, "127.0.0.1", resolve));
  const address = cfsServer.address();
  assert.ok(address && typeof address === "object");
  const camelfsUrl = `http://127.0.0.1:${address.port}`;

  try {
    const mockBrowser = {
      quickAction: async (action: string) => {
        if (action === "screenshot") {
          return new Response(new Uint8Array(VALID_PNG_BYTES), {
            status: 200,
            headers: { "content-type": "image/png", "x-browser-ms-used": "33" },
          });
        }
        if (action === "markdown") {
          return new Response(
            JSON.stringify({ success: true, result: "# Catalog Page", meta: { status: 200, title: "Catalog" } }),
          );
        }
        if (action === "snapshot") {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                markdown: "# Visual Snap",
                screenshot: VALID_PNG_BASE64,
              },
              meta: { status: 200, title: "Visual Snap" },
            }),
          );
        }
        throw new Error(`unexpected action ${action}`);
      },
    } as unknown as BrowserRun;

    const r2Writes = new Map<string, Uint8Array>();
    const mockBucket = {
      put: async (key: string, data: Uint8Array) => {
        r2Writes.set(key, data);
      },
    } as unknown as R2Bucket;

    const env = {
      BROWSER: mockBrowser,
      MEDIA_BUCKET: mockBucket,
      CAMELFS_URL: camelfsUrl,
      CAMELFS_DEV_TOKEN: "dev-token",
    };

    // 1. browser_markdown via executeBrowserTool
    const mdResult = (await executeBrowserTool(env, "browser_markdown", {
      url: "https://example.com",
    })) as { markdown: string; engine: string };
    assert.equal(mdResult.markdown, "# Catalog Page");
    assert.equal(mdResult.engine, "kitesurf");

    // 2. browser_screenshot saves to CamelFS AND returns storeToolImages-compatible inline image
    const saveScreenshot = async ({
      path: rawPath,
      contentType,
      base64,
      url,
    }: {
      path: string;
      contentType: "image/png" | "image/jpeg" | "image/webp";
      base64: string;
      url: string;
    }) => {
      const normalized = normalizeRepoPath(rawPath);
      assertScreenshotPathExtension(normalized, contentType);
      const cfs = new CamelFsClient(env as unknown as ConstructorParameters<typeof CamelFsClient>[0], "ten_test");
      await cfs.write("lin_test", {
        ref: "refs/heads/main",
        holder: "agt_test",
        author: "agent:agt_test",
        message: `browser screenshot ${url} -> ${normalized}`,
        puts: [{ path: normalized, base64, mode: 0o644 }],
      });
      return normalized;
    };

    const shotResult = await executeBrowserTool(
      env,
      "browser_screenshot",
      { url: "https://example.com", path: "screenshots/example.png" },
      { saveScreenshot },
    );
    assert.equal(writtenPuts[0]?.path, "screenshots/example.png");
    assert.equal(writtenPuts[0]?.base64, VALID_PNG_BASE64);

    const stored = await storeToolImages({ MEDIA_BUCKET: mockBucket }, "ten_test", shotResult);
    assert.equal(stored.images?.length, 1);
    assert.equal(stored.images?.[0]?.contentType, "image/png");
    assert.equal(stored.images?.[0]?.width, 2);
    assert.match(String(stored.result), /screenshots\/example\.png/);
    assert.equal(r2Writes.size, 1);

    // 3. browser_snapshot with screenshot also produces inline image + JSON text
    const snapResult = await executeBrowserTool(env, "browser_snapshot", {
      url: "https://example.com",
      formats: ["markdown", "screenshot"],
    });
    const storedSnap = await storeToolImages({ MEDIA_BUCKET: mockBucket }, "ten_test", snapResult);
    assert.equal(storedSnap.images?.length, 1);
    assert.match(String(storedSnap.result), /# Visual Snap/);

    // 4. Rejects mismatched screenshot file extension when saving to repo
    await assert.rejects(
      executeBrowserTool(
        env,
        "browser_screenshot",
        { url: "https://example.com", path: "screenshots/example.jpg" },
        { saveScreenshot },
      ),
      /Choose a \.png output path/,
    );
  } finally {
    cfsServer.closeAllConnections();
    await new Promise<void>((resolve) => cfsServer.close(() => resolve()));
  }
});
