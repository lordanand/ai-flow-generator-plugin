import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPage, openBrowser, closeBrowser } from "../lib/browser.js";

const server = new McpServer({
  name: "brave-snapshot-server",
  version: "1.0.0",
});

server.registerTool(
  "open_url",
  {
    description:
      "Open or navigate to a URL in the shared Brave browser instance",
    inputSchema: { url: z.string().url().describe("The URL to navigate to") },
  },
  async ({ url }) => {
    const page = await getPage({ autoLaunch: true });
    await page.goto(url);
    return {
      content: [
        {
          type: "text",
          text: `Navigated to ${url} (Title: ${await page.title()})`,
        },
      ],
    };
  },
);

server.registerTool(
  "open_browser",
  {
    description:
      "Open a new browser session and navigate to a URL. browser 'brave' launches local Brave; 'adspower' starts the given AdsPower profile (profile_id required). Fails if a browser is already open — call close_browser first.",
    inputSchema: {
      browser: z.enum(["brave", "adspower"]).describe("Which browser to open"),
      profile_id: z
        .string()
        .optional()
        .describe("AdsPower profile id (required when browser is 'adspower')"),
      url: z.string().min(1).describe("The URL to open"),
    },
  },
  async ({ browser, profile_id, url }) => {
    if (browser === "adspower" && !profile_id) {
      return {
        content: [{ type: "text", text: "Error: profile_id is required for AdsPower." }],
        isError: true,
      };
    }
    try {
      const { page, url: opened } = await openBrowser({
        type: browser,
        profileId: profile_id,
        url,
        pid: process.pid,
      });
      const label = browser === "adspower" ? `AdsPower profile ${profile_id}` : "Brave";
      return {
        content: [
          { type: "text", text: `Opened ${opened} in ${label} (Title: ${await page.title()})` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "close_browser",
  {
    description:
      "Close the active browser session (stops the AdsPower profile, or shuts Brave down).",
  },
  async () => {
    try {
      const session = await closeBrowser();
      const text = session
        ? `Closed ${session.type}${session.profileId ? ` profile ${session.profileId}` : ""}.`
        : "No browser was open.";
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "get_page_snapshot",
  {
    description: "Capture an ARIA snapshot of the current page",
  },
  async () => {
    const page = await getPage();
    if (!page) {
      return {
        content: [{ type: "text", text: "No active page is detected" }],
        isError: true,
      };
    }
    const ariaSnapshot = await page.ariaSnapshot();
    return {
      content: [{ type: "text", text: ariaSnapshot }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
