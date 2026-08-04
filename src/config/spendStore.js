// Permanent spend record: one line per request, appended to data/spend.jsonl.
//
// WHY A SECOND STORE. logStore keeps the last 200 requests for the log page, which
// is the right thing for debugging and useless for "how many tokens did I burn this
// month, on which project, and what did it cost" — that window is a few hours of
// real use. Tokens were being measured and then thrown away.
//
// WHY APPEND-ONLY LINES rather than maintained aggregates: appending is less code
// than a read-modify-write of nested counters, it cannot be corrupted by a crash
// halfway through an update, and it answers questions nobody has asked yet (per
// day, per session, per client) instead of only the ones designed for today. The
// cost is file size and a scan on read: ~250 bytes per request, so a heavy month is
// a couple of MB and aggregating it takes milliseconds. If it ever gets big, the
// fix is to drop old lines — the file is only ever appended to and read whole.

import { existsSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./envStore.js";

export function spendPath() {
  return join(dataDir(), "spend.jsonl");
}

/**
 * Append one request. Called from logRequest, so every route and both success and
 * failure paths are covered by construction.
 *
 * `estimated` marks a row whose token numbers are the gateway's ~4-chars-per-token
 * estimate rather than counts from the provider (that is every Kiro request), and
 * `cost: null` marks a model with no known price. Both are carried through to the
 * totals so a report can say what it does not know instead of quietly understating.
 */
export function appendSpend(row) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(spendPath(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal: accounting must never break a proxied request.
  }
}

function emptyBucket() {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    credits: 0,
    // Honesty counters: how much of the above is estimated, and how many requests
    // the cost figure actually covers.
    estimatedRequests: 0,
    costedRequests: 0,
  };
}

function add(bucket, row) {
  bucket.requests += 1;
  if (row.status === "error") bucket.errors += 1;
  bucket.inputTokens += row.inputTokens || 0;
  bucket.outputTokens += row.outputTokens || 0;
  bucket.cacheReadTokens += row.cacheReadTokens || 0;
  bucket.cacheWriteTokens += row.cacheWriteTokens || 0;
  bucket.totalTokens =
    bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
  if (row.cost != null) {
    bucket.cost = Math.round((bucket.cost + row.cost) * 1e6) / 1e6;
    bucket.costedRequests += 1;
  }
  if (row.credits) bucket.credits = Math.round((bucket.credits + row.credits) * 1e6) / 1e6;
  if (row.estimated) bucket.estimatedRequests += 1;
}

function intoGroup(groups, key, row) {
  const name = key || "unknown";
  if (!groups[name]) groups[name] = emptyBucket();
  add(groups[name], row);
}

function readRows() {
  if (!existsSync(spendPath())) return [];
  let text = "";
  try {
    text = readFileSync(spendPath(), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn last line (killed mid-append) is skipped, not fatal.
    }
  }
  return rows;
}

/**
 * Aggregate the record.
 *
 * @param {object} [options]
 * @param {string} [options.month] - "YYYY-MM"; defaults to every row. "all" is the
 *   same as omitting it.
 * @returns {object} { month, months, totals, byProject, byProfile, byProvider, byModel,
 *   byTool, byClient, byDay, firstSeen, lastSeen }
 */
export function getSpend({ month } = {}) {
  const rows = readRows();
  const months = [...new Set(rows.map((r) => String(r.ts || "").slice(0, 7)).filter(Boolean))].sort().reverse();

  const wanted = month && month !== "all" ? month : null;
  const scoped = wanted ? rows.filter((r) => String(r.ts || "").startsWith(wanted)) : rows;

  const result = {
    month: wanted || "all",
    months,
    totals: emptyBucket(),
    byProject: {},
    byProfile: {},
    byProvider: {},
    byModel: {},
    byTool: {},
    byClient: {},
    byDay: {},
    firstSeen: scoped[0]?.ts || null,
    lastSeen: scoped[scoped.length - 1]?.ts || null,
  };

  for (const row of scoped) {
    add(result.totals, row);
    intoGroup(result.byProject, row.project, row);
    intoGroup(result.byProfile, row.profile, row);
    intoGroup(result.byProvider, row.provider, row);
    intoGroup(result.byModel, row.model, row);
    intoGroup(result.byTool, row.tool, row);
    intoGroup(result.byClient, row.client, row);
    intoGroup(result.byDay, String(row.ts || "").slice(0, 10), row);
  }

  return result;
}
