import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { BRAVE_PATH, ADSPOWER_API_URLS } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Lockfile lives at the project root so every server and CLI script shares it.
export const SESSION_FILE = path.join(__dirname, "..", ".active-session.json");

export const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
const PROFILE_DIR =
  process.env.BRAVE_PROFILE_DIR ||
  path.join(os.homedir(), ".brave-playwright-profile");

// ponytail: lockfile tracks single active browser session per project workspace.
// Ceiling: local workspace scope only; upgrade path: shared IPC/daemon for multi-repo coordination.
export function saveSession({ type, endpoint, profileId, pid = process.pid }) {
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ type, endpoint, profileId, pid, startedAt: Date.now() }, null, 2),
    "utf-8"
  );
}

export function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {}
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function getActiveSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    if (session.pid && !isPidAlive(session.pid)) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    clearSession();
    return null;
  }
}

export async function isBrowserRunning() {
  const session = getActiveSession();
  if (session) {
    return session;
  }

  // Fallback check: see if Brave CDP is active on port 9222
  try {
    const res = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) {
      return { type: "brave", endpoint: CDP_URL };
    }
  } catch {}

  return null;
}

export function getEndpoint() {
  if (process.env.CDP_URL) return process.env.CDP_URL;
  const session = getActiveSession();
  if (session?.endpoint) return session.endpoint;
  return CDP_URL;
}

let cachedBrowser = null;

/**
 * Returns an active Playwright Browser instance connected over CDP.
 * Automatically resolves endpoint (env var -> active session -> default Brave port).
 */
export async function getBrowser({ autoLaunch = false } = {}) {
  if (cachedBrowser && cachedBrowser.isConnected()) {
    return cachedBrowser;
  }

  const endpoint = getEndpoint();

  try {
    cachedBrowser = await chromium.connectOverCDP(endpoint);
    cachedBrowser.on("disconnected", () => {
      cachedBrowser = null;
    });
    return cachedBrowser;
  } catch (err) {
    if (!autoLaunch) {
      return null;
    }

    // Launch Brave detached only if autoLaunch is explicitly true and default port used
    spawn(
      BRAVE_PATH,
      [
        "--remote-debugging-port=9222",
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      {
        detached: true,
        stdio: "ignore",
      }
    ).unref();

    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        cachedBrowser = await chromium.connectOverCDP(CDP_URL);
        cachedBrowser.on("disconnected", () => {
          cachedBrowser = null;
        });
        return cachedBrowser;
      } catch {}
    }
    throw new Error(`Failed to connect to Brave browser on ${CDP_URL}`);
  }
}

/**
 * Returns the current BrowserContext.
 */
export async function getContext({ autoLaunch = false } = {}) {
  const browser = await getBrowser({ autoLaunch });
  if (!browser) return null;
  const contexts = browser.contexts();
  if (contexts.length > 0) {
    return contexts[0];
  }
  return autoLaunch ? await browser.newContext() : null;
}

/**
 * Returns the currently active/visible tab in the browser.
 */
export async function getPage({ autoLaunch = false } = {}) {
  const context = await getContext({ autoLaunch });
  if (!context) return null;
  const pages = context.pages();

  if (pages.length === 0) {
    return autoLaunch ? await context.newPage() : null;
  }

  for (const page of pages) {
    try {
      const isVisible = await page.evaluate(
        () => document.visibilityState === "visible"
      );
      if (isVisible) return page;
    } catch {}
  }

  return pages[pages.length - 1];
}

/**
 * Provides current browser, context, and active page in a single call.
 */
export async function getSession({ autoLaunch = false } = {}) {
  const browser = await getBrowser({ autoLaunch });
  const context = await getContext({ autoLaunch });
  const page = await getPage({ autoLaunch });
  return { browser, context, page };
}

/**
 * AdsPower Local API helpers using native fetch.
 */
export async function startAdsPower(profileId) {
  let lastErr = null;
  for (const baseUrl of ADSPOWER_API_URLS) {
    try {
      const headers = {};
      if (process.env.ADSPOWER_API_KEY) {
        headers["Authorization"] = `Bearer ${process.env.ADSPOWER_API_KEY}`;
      }
      const res = await fetch(
        `${baseUrl}/api/v1/browser/start?user_id=${encodeURIComponent(profileId)}`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      const json = await res.json();
      if (json.code !== 0) {
        throw new Error(json.msg || "AdsPower returned an error");
      }
      const wsEndpoint = json.data?.ws?.puppeteer;
      if (!wsEndpoint) {
        throw new Error("No WebSocket endpoint returned by AdsPower");
      }
      return { wsEndpoint, data: json.data };
    } catch (err) {
      lastErr = err;
      if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("fetch failed")) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Could not connect to AdsPower Local API (${lastErr?.message || "connection refused"}). Ensure AdsPower is running and Local API is enabled.`
  );
}

export async function stopAdsPower(profileId) {
  for (const baseUrl of ADSPOWER_API_URLS) {
    try {
      const headers = {};
      if (process.env.ADSPOWER_API_KEY) {
        headers["Authorization"] = `Bearer ${process.env.ADSPOWER_API_KEY}`;
      }
      await fetch(
        `${baseUrl}/api/v1/browser/stop?user_id=${encodeURIComponent(profileId)}`,
        { headers, signal: AbortSignal.timeout(5000) }
      );
      return;
    } catch {}
  }
}

/**
 * Strips wrapping quotes and adds https:// when no scheme is given.
 */
export function normalizeUrl(url) {
  const clean = String(url ?? "").replace(/^["']|["']$/g, "").trim();
  if (clean && !/^https?:\/\//i.test(clean)) {
    return `https://${clean}`;
  }
  return clean;
}

async function waitForCdpDown(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Opens a new browser session (Brave or an AdsPower profile) and navigates to url.
 * Throws if a session is already running. `pid` owns the session lockfile.
 */
export async function openBrowser({ type, profileId, url, pid = process.pid }) {
  const target = normalizeUrl(url);
  if (!target) throw new Error("URL is required.");

  const running = await isBrowserRunning();
  if (running) {
    throw new Error(
      `Browser is already running (${running.type || "active session"}). Please close the active browser before starting a new one.`
    );
  }

  if (type !== "brave" && type !== "adspower") {
    throw new Error(`Unknown browser type "${type}". Use "brave" or "adspower".`);
  }
  if (type === "adspower" && !profileId) {
    throw new Error("AdsPower requires a profile ID.");
  }

  try {
    const page = await launchPage({ type, profileId, pid });
    await page.goto(target);
    return { page, url: target };
  } catch (err) {
    // Don't leave a half-open session behind; the next openBrowser would refuse to start.
    await closeBrowser().catch(() => clearSession());
    throw err;
  }
}

async function launchPage({ type, profileId, pid }) {
  let page;
  if (type === "brave") {
    page = await getPage({ autoLaunch: true });
    saveSession({ type: "brave", endpoint: CDP_URL, pid });
  } else {
    const { wsEndpoint } = await startAdsPower(profileId);
    saveSession({ type: "adspower", profileId, endpoint: wsEndpoint, pid });
    cachedBrowser = null;
    const browser = await getBrowser();
    if (!browser) throw new Error(`Could not connect to AdsPower profile ${profileId}.`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    page = context.pages()[0] ?? (await context.newPage());
  }
  return page;
}

/**
 * Closes the active browser session (stops the AdsPower profile, or shuts Brave down)
 * and clears the lockfile. Returns the closed session, or null if none was running.
 */
export async function closeBrowser() {
  const session = await isBrowserRunning();
  if (!session) return null;

  if (session.type === "adspower") {
    await stopAdsPower(session.profileId);
  } else {
    const browser = await getBrowser();
    if (browser) {
      // browser.close() only disconnects a CDP-attached browser; Browser.close shuts it down.
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send("Browser.close").catch(() => {});
    }
    await waitForCdpDown();
  }

  cachedBrowser = null;
  clearSession();
  return session;
}
