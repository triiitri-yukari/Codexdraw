#!/usr/bin/env node
// codex-draw: a tiny stdio MCP server that exposes one `draw` tool.
// It runs `codex exec` (official Codex CLI, your ChatGPT login) and asks the model
// to call its built-in image generation tool with the exact prompt given, then
// collects the PNGs Codex saved under ~/.codex/generated_images/<thread-id>/.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_JS =
  process.env.CODEX_JS ||
  path.join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const DEFAULT_MODEL = process.env.CODEX_DRAW_MODEL || "gpt-6-luna";
const TIMEOUT_MS = Number(process.env.CODEX_DRAW_TIMEOUT_MS || 600_000);
// Set CODEX_DRAW_KEEP_ORIGINALS=1 to keep Codex's copy in generated_images.
const KEEP_ORIGINALS = /^(1|true|yes)$/i.test(process.env.CODEX_DRAW_KEEP_ORIGINALS || "");
// Longest side of the inline JPEG preview; smaller saves the client's image tokens.
const PREVIEW_PX = Number(process.env.CODEX_DRAW_PREVIEW_PX || 768);
// Set CODEX_DRAW_LOG=off to disable the usage log.
const USAGE_LOG =
  process.env.CODEX_DRAW_LOG || path.join(path.dirname(fileURLToPath(import.meta.url)), "usage.jsonl");

const TOOL = {
  name: "draw",
  description:
    "Generate image(s) with GPT Image via Codex (uses the local ChatGPT/Codex login). " +
    "The prompt is passed to the image tool verbatim. Saves PNGs to disk and returns their paths plus a preview. " +
    "Use `prompts` for several different images at once (generated in parallel).",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Exact image prompt; not rewritten." },
      prompts: {
        type: "array", items: { type: "string" }, minItems: 1, maxItems: 4,
        description: "Several different prompts, one image each, run in parallel. Use instead of `prompt`.",
      },      filename: { type: "string", description: "Base file name without extension, e.g. 'sleepy-fox'. Default: timestamp." },
      out_dir: { type: "string", description: "Directory to save into. Default: <cwd>/codexdraw." },
      count: { type: "integer", minimum: 1, maximum: 4, description: "Variations of `prompt` in one session. Default 1." },
      references: { type: "array", items: { type: "string" }, description: "Local reference image paths." },
      model: { type: "string", description: `Codex model. Default ${DEFAULT_MODEL}.` },
      preview: { type: "boolean", description: "Return a downscaled JPEG preview inline. Default true." },
    },
  },
};

process.stdout.on("error", () => process.exit(0)); // client went away

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function runCodex(args) {
  return new Promise((resolve, reject) => {
    // stdin must be closed: codex exec waits to read extra prompt text from a piped stdin.
    const child = spawn(process.execPath, [CODEX_JS, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let threadId = null;
    let lastMessage = "";
    let usage = null;
    const errors = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`codex exec timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "thread.started") threadId = ev.thread_id;
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") lastMessage = ev.item.text;
      if (ev.type === "turn.completed") usage = ev.usage || null;
      if (ev.type === "turn.failed" || ev.type === "error") errors.push(ev.error?.message || ev.message || line);
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, threadId, lastMessage, usage, errors, stderr: stderr.slice(-2000) });
    });
  });
}

// Downscale to a JPEG with Windows PowerShell's System.Drawing; returns base64 or null.
function makePreview(src, maxSide = PREVIEW_PX) {
  if (process.platform !== "win32") return Promise.resolve(null);
  const dst = path.join(os.tmpdir(), `codex-draw-preview-${process.pid}-${Date.now()}.jpg`);
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($env:CD_SRC)
$s = [Math]::Min(1.0, ${maxSide} / [Math]::Max($img.Width, $img.Height))
$bmp = New-Object System.Drawing.Bitmap ([int]($img.Width * $s)), ([int]($img.Height * $s))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($img, 0, 0, $bmp.Width, $bmp.Height)
$bmp.Save($env:CD_DST, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $bmp.Dispose(); $img.Dispose()`;
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      windowsHide: true,
      env: { ...process.env, CD_SRC: src, CD_DST: dst },
    });
    child.on("error", () => resolve(null));
    child.on("close", async (code) => {
      if (code !== 0) return resolve(null);
      try {
        const b64 = (await fs.readFile(dst)).toString("base64");
        await fs.rm(dst, { force: true });
        resolve(b64);
      } catch {
        resolve(null);
      }
    });
  });
}

// One Codex session: the model calls the image tool `count` times with `prompt`.
async function runSession({ prompt, count, refs, model }) {
  const instruction =
    `Call your image generation tool ${count === 1 ? "exactly once" : `exactly ${count} times (one image per call)`} ` +
    `using this prompt verbatim. Do not rewrite, refine, or add to it.` +
    (refs.length ? " Use the attached image(s) as reference." : "") +
    ` Do nothing else, then reply only with DONE.\n\nPROMPT:\n${prompt}`;

  const codexArgs = [
    "exec", "--json", "--skip-git-repo-check", "--ephemeral",
    "-s", "read-only",
    "-m", model,
    "-c", "model_reasoning_effort=low",
    "-C", os.tmpdir(),
  ];
  for (const r of refs) codexArgs.push("-i", r);
  codexArgs.push("--", instruction);

  const started = Date.now();
  const res = await runCodex(codexArgs);
  const secs = Math.round((Date.now() - started) / 1000);
  if (!res.threadId) throw new Error(`codex exec did not start a thread (exit ${res.code}). ${res.stderr}`);

  const genDir = path.join(CODEX_HOME, "generated_images", res.threadId);
  let pngs = [];
  try {
    const entries = await fs.readdir(genDir);
    pngs = await Promise.all(
      entries.filter((f) => f.toLowerCase().endsWith(".png")).map(async (f) => {
        const p = path.join(genDir, f);
        return { p, t: (await fs.stat(p)).mtimeMs };
      })
    );
    pngs.sort((a, b) => a.t - b.t);
  } catch {
    /* no images */
  }
  if (!pngs.length) {
    throw new Error(
      `No image was generated (exit ${res.code}). Model said: ${res.lastMessage || "(nothing)"}` +
        (res.errors.length ? `\nErrors: ${res.errors.join("; ")}` : "")
    );
  }
  return { pngs: pngs.map((x) => x.p), genDir, usage: res.usage, secs };
}

// Backend-only usage log (one JSON line per draw call); never returned to the MCP client.
async function logUsage(entry) {
  try {
    if (USAGE_LOG.toLowerCase() === "off") return;
    await fs.appendFile(USAGE_LOG, JSON.stringify(entry) + "\n");
  } catch {
    /* logging must never break drawing */
  }
}

async function draw(args) {
  const prompts = (Array.isArray(args.prompts) && args.prompts.length ? args.prompts : [args.prompt])
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!prompts.length) throw new Error("prompt or prompts is required");
  // `count` means variations of a single prompt; with several prompts each gets one image.
  const count = prompts.length === 1 ? Math.min(4, Math.max(1, Number(args.count) || 1)) : 1;
  const outDir = path.resolve(args.out_dir || path.join(process.cwd(), "codexdraw"));
  const base = (args.filename || `draw-${new Date().toISOString().replace(/[:.]/g, "-")}`).replace(/[\\/:*?"<>|]/g, "_");
  const refs = (args.references || []).map((r) => path.resolve(r));
  const model = args.model || DEFAULT_MODEL;

  const started = Date.now();
  const results = await Promise.allSettled(prompts.map((prompt) => runSession({ prompt, count, refs, model })));

  await fs.mkdir(outDir, { recursive: true });
  const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value.pngs : []));
  const saved = [];
  for (let i = 0; i < all.length; i++) {
    const dest = path.join(outDir, all.length === 1 ? `${base}.png` : `${base}-${i + 1}.png`);
    await fs.copyFile(all[i], dest);
    saved.push(dest);
  }
  // Every image is copied, so drop Codex's copies (sessions are ephemeral; nothing else refers to them).
  if (!KEEP_ORIGINALS) {
    for (const r of results) {
      if (r.status === "fulfilled") await fs.rm(r.value.genDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!saved.length) {
    throw new Error(results.map((r) => r.reason?.message || String(r.reason)).join("\n"));
  }

  await logUsage({
    time: new Date().toISOString(),
    model,
    mode: prompts.length > 1 ? "parallel" : count > 1 ? "count" : "single",
    images: saved.length,
    secs: Math.round((Date.now() - started) / 1000),
    sessions: results.map((r, i) =>
      r.status === "fulfilled"
        ? { prompt: prompts[i], images: r.value.pngs.length, secs: r.value.secs, usage: r.value.usage }
        : { prompt: prompts[i], error: String(r.reason?.message || r.reason) }
    ),
    files: saved,
  });

  const expected = prompts.length * count;
  const text = saved.join("\n") + (saved.length < expected ? `\n(only ${saved.length} of ${expected} images were generated)` : "");
  const content = [{ type: "text", text }];
  if (args.preview !== false) {
    for (const p of saved) {
      const b64 = await makePreview(p);
      if (b64) content.push({ type: "image", data: b64, mimeType: "image/jpeg" });
    }
  }
  return content;
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "codex-draw", version: "0.1.0" },
        },
      });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    } else if (method === "tools/call") {
      if (params?.name !== "draw") throw new Error(`Unknown tool: ${params?.name}`);
      try {
        send({ jsonrpc: "2.0", id, result: { content: await draw(params.arguments || {}) } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } });
      }
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } });
  }
});
