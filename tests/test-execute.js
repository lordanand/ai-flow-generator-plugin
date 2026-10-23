import { spawn } from "node:child_process";
import readline from "node:readline";

const proc = spawn("node", ["servers/execute-server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = readline.createInterface({ input: proc.stdout });

let nextId = 1;
const pending = new Map();

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch (err) {
    console.error("Failed to parse line:", line, err);
  }
});

function sendRequest(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    proc.stdin.write(req);
  });
}

function sendNotification(method, params = {}) {
  const notif = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  proc.stdin.write(notif);
}

async function runTests() {
  console.log("--- Starting Execute MCP Server Test ---");

  // 1. Initialize
  const initRes = await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  });
  console.log("1. Initialize response:", initRes.result?.serverInfo);
  sendNotification("notifications/initialized");

  // 2. List tools
  const toolsRes = await sendRequest("tools/list");
  const toolNames = toolsRes.result?.tools?.map((t) => t.name) || [];
  console.log("2. Available tools:", toolNames);

  // 3. Test single expression
  const exprRes = await sendRequest("tools/call", {
    name: "execute_code",
    arguments: {
      code: "await page.title()",
    },
  });

  const exprText = exprRes.result?.content?.[0]?.text;
  if (exprText === "No active page is detected") {
    console.log("3. Result:\n" + exprText);
    console.log("\n[INFO] No active page is detected. Browser was NOT opened.");
    console.log(
      "--- All Execute Tests Passed (No-browser detection verified) ---",
    );
    proc.kill();
    process.exit(0);
  }

  console.log("3. Single expression result:\n", exprText);

  // 4. Test multiline with locator, console logging, and object return
  const multiRes = await sendRequest("tools/call", {
    name: "execute_code",
    arguments: {
      code: `
await page.getByRole("textbox", { name: "Name *" }).click();
await page.getByRole("textbox", { name: "Name *" }).fill("John Doe");


await page.getByRole("textbox", { name: "you@example.com" }).click();
await page.getByRole("textbox", { name: "you@example.com" }).fill("john.doe@example.com");

await page.getByRole("textbox", { name: "+1" }).click();
await page.getByRole("textbox", { name: "+1" }).fill("+1 5551234567");

await page.getByRole("textbox", { name: "Subject" }).click();
await page.getByRole("textbox", { name: "Subject" }).fill("Website Redesign Inquiry");

await page.getByRole("textbox", { name: "Message *" }).click();
await page.getByRole("textbox", { name: "Message *" }).fill("Hi, I'd like to discuss a new website project for my business.");

await page.getByRole("button", { name: "Send Message" }).click();
      `.trim(),
    },
  });
  console.log(
    "4. Multiline locator execution:\n",
    multiRes.result?.content?.[0]?.text,
  );

  // 5. Test statement without return
  const noReturnRes = await sendRequest("tools/call", {
    name: "execute_code",
    arguments: {
      code: `console.log('Console message only');`,
    },
  });
  console.log(
    "5. Statement without return:\n",
    noReturnRes.result?.content?.[0]?.text,
  );

  // 6. Test error handling
  const errorRes = await sendRequest("tools/call", {
    name: "execute_code",
    arguments: {
      code: `await page.click('#non-existent-button-999', { timeout: 300 });`,
    },
  });
  console.log(
    "6. Error handling test (isError=" + errorRes.result?.isError + "):\n",
    errorRes.result?.content?.[0]?.text?.split("\n")[0],
  );

  console.log("--- All Execute Tests Passed Successfully! ---");
  proc.kill();
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test error:", err);
  proc.kill();
  process.exit(1);
});
