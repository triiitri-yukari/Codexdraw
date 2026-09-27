#!/usr/bin/env node
// Summarize codex-draw usage.jsonl with token pricing.
// Usage: node report.mjs [path/to/usage.jsonl]
// Rates are USD per 1M tokens; override with env RATE_INPUT, RATE_CACHED, RATE_OUTPUT, RATE_CACHE_WRITE.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RATES = {
  input: Number(process.env.RATE_INPUT ?? 0.1),
  cached: Number(process.env.RATE_CACHED ?? 0.01),
  output: Number(process.env.RATE_OUTPUT ?? 0.5),
  cacheWrite: Number(process.env.RATE_CACHE_WRITE ?? 0.125),
};

const logPath =
  process.argv[2] ||
  process.env.CODEX_DRAW_LOG ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "usage.jsonl");

if (!fs.existsSync(logPath)) {
  console.log(`No usage log yet at ${logPath}`);
  process.exit(0);
}

// input_tokens includes cached tokens; reasoning tokens are billed as output.
function cost(u = {}) {
  const input = u.input_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  const write = u.cache_write_input_tokens ?? 0;
  const uncached = Math.max(0, input - cached - write);
  const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
  return {
    input, cached, write, uncached, output,
    usd: (uncached * RATES.input + cached * RATES.cached + write * RATES.cacheWrite + output * RATES.output) / 1e6,
  };
}

const rows = [];
const totals = { calls: 0, images: 0, input: 0, cached: 0, write: 0, uncached: 0, output: 0, usd: 0 };
for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  const c = { input: 0, cached: 0, write: 0, uncached: 0, output: 0, usd: 0 };
  for (const s of e.sessions || []) {
    const k = cost(s.usage);
    for (const key of Object.keys(c)) c[key] += k[key];
  }
  rows.push({
    time: e.time.slice(0, 19).replace("T", " "),
    mode: e.mode,
    imgs: e.images,
    secs: e.secs,
    sessions: (e.sessions || []).length,
    input: c.input,
    cached: c.cached,
    uncached: c.uncached,
    output: c.output,
    usd: c.usd.toFixed(5),
    "usd/img": e.images ? (c.usd / e.images).toFixed(5) : "-",
  });
  totals.calls++;
  totals.images += e.images;
  for (const key of ["input", "cached", "write", "uncached", "output", "usd"]) totals[key] += c[key];
}

console.log(`Rates per 1M tokens: input $${RATES.input}, cached $${RATES.cached}, output $${RATES.output}, cache write $${RATES.cacheWrite}`);
console.log("Covers the Codex model's tokens only; image rendering is billed separately.\n");
console.table(rows);
console.log(
  `\nTotal: ${totals.calls} calls, ${totals.images} images, $${totals.usd.toFixed(5)} ` +
    `(avg $${(totals.usd / Math.max(1, totals.images)).toFixed(5)}/image)`
);
