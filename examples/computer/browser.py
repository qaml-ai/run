"""Browserbase browser capability. This provider does not offer a Linux shell."""
import asyncio
import json
import os
import time

from camelai_run import ToolContext, tool
from tools import ComputerTools


class BrowserbaseSession:
    @classmethod
    async def create(cls, lifetime=900):
        from browserbase import AsyncBrowserbase
        from playwright.async_api import async_playwright
        self = cls()
        self.client = AsyncBrowserbase(api_key=os.environ["BROWSERBASE_API_KEY"], max_retries=0)
        self.session = self.playwright = self.browser = None
        self.expires_at = time.monotonic() + lifetime
        try:
            options = {"project_id": os.environ["BROWSERBASE_PROJECT_ID"]} if os.getenv("BROWSERBASE_PROJECT_ID") else {}
            self.session = await self.client.sessions.create(api_timeout=lifetime, keep_alive=False, **options)
            self.id = self.session.id
            self.playwright = await async_playwright().start()
            self.browser = await self.playwright.chromium.connect_over_cdp(self.session.connect_url, timeout=30000)
            context = self.browser.contexts[0]
            self.page = context.pages[0] if context.pages else await context.new_page()
            self.page.set_default_timeout(15000)
            return self
        except BaseException:
            await self.close()
            raise

    async def close(self):
        try:
            if self.browser:
                await self.browser.close()
        finally:
            try:
                if self.session:
                    await self.client.sessions.update(self.session.id, status="REQUEST_RELEASE")
            finally:
                if self.playwright:
                    await self.playwright.stop()
                await self.client.close()


class BrowserTools(ComputerTools):
    async def call(self, operation, payload, context):
        command = json.dumps([operation, payload], sort_keys=True)
        async def action():
            async with asyncio.timeout(min(30, max(0.1, self.computer.expires_at - time.monotonic()))):
                page = self.computer.page
                if operation == "navigate":
                    from urllib.parse import urlsplit
                    if urlsplit(payload).scheme not in ("https", "http"):
                        raise ValueError("Only HTTP(S) navigation is supported")
                    await page.goto(payload, wait_until="domcontentloaded")
                    result = {"url": page.url, "title": await page.title()}
                elif operation == "read":
                    result = {"url": page.url, "title": await page.title(), "text": (await page.locator("body").inner_text())[:16000]}
                elif operation == "click":
                    await page.locator(payload).click()
                    result = {"clicked": True}
                elif operation == "fill":
                    await page.locator(payload["selector"]).fill(payload["text"])
                    result = {"filled": True}
                elif operation == "evaluate":
                    result = await page.evaluate(payload)
                else:
                    raise ValueError("Unknown browser operation")
                return {"stdout": json.dumps(result, ensure_ascii=False), "stderr": "", "exit_code": 0}
        return await self.perform(command, 30, context, action)

    def tools(self):
        @tool(timeout=40, exposure="direct")
        async def browser_navigate(url: str, context: ToolContext):
            """Navigate your remote browser to an HTTP(S) URL. Browser state persists across turns."""
            return await self.call("navigate", url, context)

        @tool(timeout=40, exposure="direct")
        async def browser_read(context: ToolContext):
            """Read the current remote page URL, title and visible text."""
            return await self.call("read", None, context)

        @tool(timeout=40, exposure="direct")
        async def browser_click(selector: str, context: ToolContext):
            """Click a CSS selector in the remote page."""
            return await self.call("click", selector, context)

        @tool(timeout=40, exposure="direct")
        async def browser_fill(selector: str, text: str, context: ToolContext):
            """Fill a form input identified by CSS selector in the remote page."""
            return await self.call("fill", {"selector": selector, "text": text}, context)

        @tool(timeout=40, exposure="direct")
        async def browser_evaluate(expression: str, context: ToolContext):
            """Evaluate JavaScript in the remote web page and return a JSON-serializable result. This is browser JavaScript, with no host shell or filesystem access."""
            return await self.call("evaluate", expression, context)

        return [browser_navigate, browser_read, browser_click, browser_fill, browser_evaluate]
