# Playwright-Core Brave Automation & MCP Server

Minimal, lightweight automation setup using `playwright-core` with Brave browser and MCP servers over Chrome DevTools Protocol (CDP).

## Features
- **Zero Browser Binaries Downloaded**: Uses locally installed Brave browser.
- **Shared & Persisted Browser**: Any MCP server or CLI script connects to the same running Brave session on port 9222.
- **ARIA Page Snapshots**: Standard semantic ARIA tree (`page.ariaSnapshot()`) for accessible locator inspection.
- **Extensible**: Add future MCP servers under `servers/` by importing `{ getPage } from '../lib/browser.js'`.

## Claude Code plugin: `/run-flow-recorder`

This folder is also a Claude Code plugin. `/run-flow-recorder` fills a multi-step form once for **every row** of a CSV:

1. Asks for anything you didn't pass: CSV path, steps JS path, browser (`brave`, or `adspower` with one or more profile ids), URL, and which page is the last step.
2. For each row it opens a **new** browser (AdsPower uses the next profile id, and asks for another when the list runs out), replays the steps already saved in the JS file, and records any page that has no saved step yet.
3. The last step is saved with `success: true`. Reaching it ends the row, and the browser is closed.
4. Progress is saved to `<steps file>.progress.json` after every step and row. Run the command again with the same files to resume.
5. When every row is done or skipped, it runs the Verify Detectors prompt (`docs/verify-detector.md`) on the steps file and saves the result back to it, then the Pointer → Touch Converter prompt (`docs/touch-converter.md`), which writes `<name>-touch.js` next to it.

### Install

Run `npm install` first: the plugin's MCP servers need `node_modules`. Then install it for every project (user scope) from this folder's marketplace:

```bash
claude plugin install ai-flow-generator --marketplace "D:/autobot-gui-master/ai-flow-generator-plugin"
```

Or, from inside Claude Code: `/plugin install ai-flow-generator --marketplace D:/autobot-gui-master/ai-flow-generator-plugin`

Claude Code reads the installed plugin straight from this folder, so edits here take effect at the next session start, or right away with `/reload-plugins`.

Then in Claude Code:

```
/run-flow-recorder D:/work/data.csv D:/work/script.js adspower k1a2b3 k1a2b4 https://example.com
```

(If another command has the same name, use `/ai-flow-generator:run-flow-recorder`.)

The plugin starts the three MCP servers itself (declared under `mcpServers` in `.claude-plugin/plugin.json`), and adds these tools:

| Tool | Server | What it does |
| --- | --- | --- |
| `open_browser` / `close_browser` | brave-snapshot | Open Brave or an AdsPower profile at a URL; close it |
| `replay_steps` | brave-execute | Run saved steps for one CSV row until the success step, an unknown page, a stuck step or an error |
| `inspect_steps` | brave-execute | Load a steps file without a browser and list ids, detect counts and remaining `.click()` calls |
| `start_run`, `next_profile`, `add_profiles`, `mark_step`, `mark_row`, `mark_phase`, `get_run_state` | csv-template | Resumable run progress |

## Project layout

```
.claude-plugin/plugin.json   plugin manifest + the MCP servers it starts
skills/run-flow-recorder/    the /run-flow-recorder workflow (SKILL.md)
servers/                     MCP servers: snapshot, execute, template
lib/                         shared code: browser.js, template.js, run-state.js, steps-file.js
bin/                         CLI launchers: open-brave.js, open-ads.js
tests/                       test scripts, mcp-client.js and fixtures/ (run from the project root via npm scripts)
docs/                        prompts: rules.md, prompt.md, prompt-new.md, verify-detector.md, touch-converter.md
web/index.html               setup and prompts page
```

Run tests from the project root: `npm test`, `npm run test:execute`, `npm run test:template`, `npm run test:state`, `npm run test:replay`.

## Usage

### 1. Open a Link

#### Option A: Brave Browser (Single URL argument)
```bash
node bin/open-brave.js "https://example.com"
```
*(If the URL argument is omitted, you will be prompted for it interactively.)*

#### Option B: AdsPower Browser (Profile ID + URL arguments)
```bash
node bin/open-ads.js "<profile_id>" "https://example.com"
```
*(If either argument is omitted, you will be prompted interactively.)*

> **Note**: Only one browser instance can run at a time. Close the active instance before launching another.

### 2. Run MCP Servers
- **Snapshot Server**:
  ```bash
  node servers/snapshot-server.js
  ```
- **Code Execution Server**:
  ```bash
  node servers/execute-server.js
  ```
- **CSV Template Server**:
  ```bash
  node servers/template-server.js
  ```

### 3. Add to Antigravity Global Config
In `~/.gemini/config/mcp_config.json`, provide the absolute paths:
```json
{
  "mcpServers": {
    "brave-snapshot": {
      "command": "node",
      "args": ["c:/Users/LENOVO/Desktop/test-delete-if-forget/servers/snapshot-server.js"]
    },
    "brave-execute": {
      "command": "node",
      "args": ["c:/Users/LENOVO/Desktop/test-delete-if-forget/servers/execute-server.js"]
    },
    "csv-template": {
      "command": "node",
      "args": ["c:/Users/LENOVO/Desktop/test-delete-if-forget/servers/template-server.js"]
    }
  }
}
```

### 4. Setup in Claude (CLI & Desktop)

#### Option 1: Claude Code CLI (`claude mcp add`)
Run these commands from the root of this project:

**Step 1: Add the Snapshot Server**
```bash
claude mcp add brave-snapshot -- node servers/snapshot-server.js
```

**Step 2: Add the Code Execution Server**
```bash
claude mcp add brave-execute -- node servers/execute-server.js
```

**Step 3: Add the CSV Template Server**
```bash
claude mcp add csv-template -- node servers/template-server.js
```

*(Optional: add `--scope project` to explicitly scope to this project folder, or `--scope user` for global)*:
```bash
claude mcp add brave-snapshot -- node servers/snapshot-server.js
claude mcp add brave-execute -- node servers/execute-server.js
claude mcp add csv-template -- node servers/template-server.js
```

---

#### Option 2: Claude Desktop (using existing `mcp_config.json`)
Copy the already created `mcp_config.json` directly into Claude Desktop's config folder with one PowerShell command:

```powershell
New-Item -ItemType Directory -Force -Path "$env:APPDATA\Claude" | Out-Null; Copy-Item "mcp_config.json" "$env:APPDATA\Claude\claude_desktop_config.json" -Force
```

Or open the config file in Notepad:
```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

#### Step 2: Launch the Browser
Open your browser session (Brave or AdsPower):
```bash
# Brave:
node bin/open-brave.js "https://example.com"

# Or AdsPower:
node bin/open-ads.js "<profile_id>" "https://example.com"
```

#### Step 3: Restart Claude Desktop
Close Claude Desktop completely and restart it. You will see the tool icon (hammer) in your chats with:
- `open_url`
- `get_page_snapshot`
- `execute_code`
- `replace_template` (or alias `fill_template`)

### 5. Adding New MCP Servers
Create `servers/my-server.js`:
```javascript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPage } from '../lib/browser.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

// Add custom tools using getPage()
// server.registerTool('custom_tool', { description: '...' }, async () => { ... });

await server.connect(new StdioServerTransport());
```
Then register it in your MCP configuration file.

