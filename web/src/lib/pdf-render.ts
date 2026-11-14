import { randomBytes } from "node:crypto";
import { chromium, type Browser } from "playwright-core";

// Prints one of this app's pages to PDF. The page is printed by a headless Edge on the server, so Hebrew,
// right-to-left layout and the logo come out exactly as on screen.
// The headless browser has no login. It opens a random address that exists only while the file is being made,
// and that address carries a payload that the page on the other side reads back with takeRenderKey.

const TTL_MS = 30_000;
const g = globalThis as unknown as { __aoRenderKeys?: Map<string, { payload: string; expires: number }>; __aoPdfBrowser?: Promise<Browser> };
const keys = (g.__aoRenderKeys ??= new Map());

/** Called by a render page: returns the payload behind a key while the key is alive. */
export function takeRenderKey(key: string): string | null {
  const entry = keys.get(key);
  return entry && entry.expires > performance.timeOrigin + performance.now() ? entry.payload : null;
}

async function browser(): Promise<Browser> {
  const current = g.__aoPdfBrowser ? await g.__aoPdfBrowser.catch(() => null) : null;
  if (current?.isConnected()) return current;
  g.__aoPdfBrowser = chromium.launch({ channel: process.env.AO_PDF_BROWSER_CHANNEL || "msedge", headless: true });
  return g.__aoPdfBrowser;
}

export type PrintOptions = {
  /** The render page's address for a key, e.g. `/quotes/render/${key}`. */
  path: (key: string) => string;
  /** What the render page gets back from takeRenderKey. */
  payload: string;
  /** Where the headless browser reaches this server. */
  origin: string;
  /** A selector that means the document is drawn. */
  ready: string;
};

export async function printPage(options: PrintOptions): Promise<Buffer> {
  const key = randomBytes(32).toString("base64url");
  const now = performance.timeOrigin + performance.now();
  for (const [k, v] of keys) if (v.expires <= now) keys.delete(k);
  keys.set(key, { payload: options.payload, expires: now + TTL_MS });
  const context = await (await browser()).newContext({ locale: "he-IL" });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${options.origin}${options.path(key)}`, { waitUntil: "networkidle", timeout: 20_000 });
    if (!response?.ok()) throw new Error(`render page answered ${response?.status()}`);
    await page.waitForSelector(options.ready, { timeout: 10_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((done) => img.addEventListener("load", done, { once: true })))));
    });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "16mm", left: "13mm", right: "13mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: '<div style="width:100%;font-size:8px;color:#666;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally {
    keys.delete(key);
    await context.close();
  }
}

/** Where the headless browser reaches this server. It runs on the same machine, so the request's own origin works. */
export function internalOrigin(request: Request): string {
  return process.env.AO_INTERNAL_BASE_URL || new URL(request.url).origin;
}
