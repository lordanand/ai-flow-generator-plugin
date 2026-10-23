import readline from "node:readline/promises";
import {
  getBrowser,
  isBrowserRunning,
  clearSession,
  openBrowser,
  closeBrowser,
  normalizeUrl,
} from "../lib/browser.js";

const running = await isBrowserRunning();
if (running) {
  console.error(
    `Browser is already running (${running.type || "active session"}). Please close the active browser before starting a new one.`
  );
  process.exit(1);
}

let profileId = process.argv[2];
let url = process.argv[3];

if (!profileId || !url) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  if (!profileId) {
    profileId = (await rl.question("Enter AdsPower Profile ID: ")).trim();
  }
  if (!url) {
    url = (await rl.question("Enter URL: ")).trim();
  }
  rl.close();
}

profileId = (profileId ?? "").replace(/^["']|["']$/g, "").trim();
url = normalizeUrl(url);

if (!profileId || !url) {
  console.error("Error: Both Profile ID and URL are required.");
  process.exit(1);
}

console.log(`Connecting to AdsPower for Profile ID: ${profileId}...`);
try {
  await openBrowser({ type: "adspower", profileId, url, pid: process.pid });
} catch (err) {
  console.error(`\n[AdsPower Error] ${err.message}`);
  clearSession();
  process.exit(1);
}
const browser = await getBrowser();

const cleanup = async () => {
  try {
    await closeBrowser();
  } catch {}
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
browser.on("disconnected", () => {
  console.log("AdsPower browser disconnected.");
  clearSession();
  process.exit(0);
});

console.log(
  `Successfully opened ${url} in AdsPower (Profile ID: ${profileId}).`
);
console.log("Browser session is running. Press Ctrl+C to stop.");

// Keep process alive so browser session remains tracked and active
await new Promise(() => {});
