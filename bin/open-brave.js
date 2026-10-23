import readline from "node:readline/promises";
import {
  getBrowser,
  isBrowserRunning,
  clearSession,
  openBrowser,
  normalizeUrl,
} from "../lib/browser.js";

const running = await isBrowserRunning();
if (running) {
  console.error(
    `Browser is already running (${running.type || "active session"}). Please close the active browser before starting a new one.`,
  );
  process.exit(1);
}

let url = process.argv[2];
if (!url) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  url = (await rl.question("Enter URL: ")).trim();
  rl.close();
}

url = normalizeUrl(url);
if (!url) {
  console.error("Error: URL is required.");
  process.exit(1);
}

await openBrowser({ type: "brave", url, pid: process.pid });
const browser = await getBrowser();

const cleanup = () => {
  clearSession();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
browser.on("disconnected", () => {
  console.log("Brave browser disconnected.");
  cleanup();
});

console.log(`Successfully opened ${url} in Brave.`);
console.log("Browser session is running. Press Ctrl+C to stop.");

// Keep process alive so browser session remains tracked and active
await new Promise(() => {});
