# Codexdraw

A tiny MCP server that gives AI agents a `draw` tool for **GPT Image**, powered by the official [Codex CLI](https://github.com/openai/codex) and your existing ChatGPT/Codex login.

No API key, no dependencies. It never reads your login tokens: all it does is run `codex exec`.

## How it works

1. The `draw` tool starts `codex exec` (default model `gpt-6-luna`, low reasoning effort, read-only sandbox).
2. The model is told to call its built-in image generation tool with your prompt **verbatim**, with no rewriting.
3. Codex saves the PNG under `~/.codex/generated_images/<thread-id>/`. The server copies it into your output folder, then deletes Codex's copy so images aren't stored twice.
4. The tool replies with the saved file paths and a small JPEG preview.

## Requirements

- Node.js 22+
- Codex CLI installed and logged in (`npm i -g @openai/codex@latest`, then `codex login`)
- Windows for inline previews (they use PowerShell's System.Drawing). On other platforms images are still generated and saved, just without a preview.

> Keep the Codex CLI up to date. If the Codex desktop app writes config keys an older CLI doesn't understand, `codex exec` will fail to start.

## Install

**Claude Code**

```bash
claude mcp add --scope user codex-draw -- node "/path/to/codex-draw-mcp/server.mjs"
```

**Other MCP clients** (Claude Desktop, Cursor, VS Code, Windsurf, …)

```json
{
  "mcpServers": {
    "codex-draw": {
      "command": "node",
      "args": ["/path/to/codex-draw-mcp/server.mjs"]
    }
  }
}
```

Restart the client afterwards so it picks up the new tool.

## The `draw` tool

| Parameter | Description |
|---|---|
| `prompt` | Image prompt, passed to the image tool verbatim. |
| `prompts` | Up to 4 different prompts, one image each, generated **in parallel**. Use instead of `prompt`. |
| `count` | 1–4 variations of a single `prompt`, generated one after another in one session. |
| `filename` | Base file name without extension (default: timestamp). Multiple images get `-1`, `-2`, … |
| `out_dir` | Where to save the PNGs (default: `<working dir>/out`). |
| `references` | Local image paths to use as references. |
| `model` | Codex model (default `gpt-6-luna`). |
| `preview` | Return an inline JPEG preview (default `true`). |

The reply contains only the saved paths (plus previews), so it stays small.

### Which mode to use

| You want | Use | 3 images take |
|---|---|---|
| One picture | `prompt` | ~35s for one |
| Several **different** pictures | `prompts` | ~50s |
| Variations of **one** idea | `prompt` + `count` | ~85s |

Tip: add "no text" to prompts if you don't want the model to add lettering to the picture.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_DRAW_MODEL` | `gpt-6-luna` | Default Codex model |
| `CODEX_DRAW_TIMEOUT_MS` | `600000` | Timeout per Codex session |
| `CODEX_DRAW_PREVIEW_PX` | `768` | Longest side of the inline preview (smaller saves the agent's image tokens) |
| `CODEX_DRAW_LOG` | `usage.jsonl` next to the server | Usage log path, or `off` to disable |
| `CODEX_JS` | `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js` | Path to Codex's `codex.js`; set this on macOS/Linux or for non-npm installs |
| `CODEX_DRAW_KEEP_ORIGINALS` | off | Set to `1` to keep Codex's own copy in `generated_images` (by default it is deleted once saved to `out_dir`) |
| `CODEX_HOME` | `~/.codex` | Codex home (where generated images are stored) |

With Claude Code, pass them with `-e`, e.g. `claude mcp add --scope user codex-draw -e CODEX_DRAW_LOG=off -- node ...`.

## Usage log

Each `draw` call appends one line to `usage.jsonl`: mode, time taken, files, and the Codex model's token usage per session. This log never goes into the tool's reply.

Summarize it with token pricing:

```bash
node codex-draw-mcp/report.mjs
```

Rates default to $0.10 input / $0.01 cached input / $0.50 output / $0.125 cache writes per 1M tokens. Override them with `RATE_INPUT`, `RATE_CACHED`, `RATE_OUTPUT` and `RATE_CACHE_WRITE`.

The log covers only the model's tokens, about 38k input tokens per session (mostly cached). Image rendering counts against your ChatGPT plan's image allowance separately.

## Notes

- Some MCP clients time out tool calls around 60s. `count` with 3–4 images can exceed that; `prompts` (parallel) is safer.
- Each prompt in `prompts` starts its own Codex session, so it uses more model tokens than `count`, but the difference is a fraction of a cent.
- Codex's image tool results come from your own ChatGPT account and follow OpenAI's usage policies.

## License

MIT (see [LICENSE](LICENSE)).
