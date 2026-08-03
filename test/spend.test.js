// Spend accounting: the permanent record, and how a request gets attributed to a
// project. The gateway measured tokens for months and then threw them away with the
// 200-entry log window, so "how much did this month cost, on which project" was
// unanswerable — these tests pin down the arithmetic and the attribution signals.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "agentos-spend-test-"));
process.env.AGENTOS_DATA_DIR = dataDir;

const { appendSpend, getSpend, spendPath } = await import("../src/config/spendStore.js");
const { projectFromRequest, clientFromRequest } = await import("../src/lib/requestContext.js");

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const row = (over = {}) => ({
  ts: "2026-08-03T10:00:00.000Z",
  tool: "claude",
  project: "/home/amit/project/gateway",
  client: "claude-cli/2.1.0",
  provider: "Kiro A",
  model: "claude-sonnet-4.5",
  status: "ok",
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0.0045,
  credits: 0.02,
  estimated: true,
  ...over,
});

test("totals add up across every dimension, and months are listed newest first", () => {
  appendSpend(row());
  appendSpend(row({ project: "/home/amit/project/other", model: "claude-opus-5", provider: "aeorlink", estimated: false, credits: 0, cost: 0.02 }));
  appendSpend(row({ ts: "2026-07-30T09:00:00.000Z", tool: "codex", status: "error", inputTokens: 0, outputTokens: 0, cost: null, credits: 0 }));

  const all = getSpend();
  assert.equal(all.totals.requests, 3);
  assert.equal(all.totals.errors, 1);
  assert.equal(all.totals.inputTokens, 2000);
  assert.equal(all.totals.outputTokens, 200);
  assert.equal(all.totals.totalTokens, 2200);
  assert.deepEqual(all.months, ["2026-08", "2026-07"]);

  const august = getSpend({ month: "2026-08" });
  assert.equal(august.totals.requests, 2, "the July row must be out of scope");
  assert.equal(august.byProject["/home/amit/project/gateway"].requests, 1);
  assert.equal(august.byProject["/home/amit/project/other"].totalTokens, 1100);
  assert.equal(august.byProvider["aeorlink"].requests, 1);
  assert.equal(august.byModel["claude-opus-5"].cost, 0.02);
  assert.equal(august.byTool["claude"].requests, 2);
  assert.equal(august.byClient["claude-cli/2.1.0"].requests, 2);
  assert.equal(august.byDay["2026-08-03"].requests, 2);
});

test("cost and estimate honesty counters travel with the totals", () => {
  const august = getSpend({ month: "2026-08" });
  // Both August rows have a price, only one has estimated tokens.
  assert.equal(august.totals.costedRequests, 2);
  assert.equal(august.totals.cost, 0.0245);
  assert.equal(august.totals.estimatedRequests, 1, "so a report can say which numbers are estimates");
  assert.equal(august.byProvider["Kiro A"].credits, 0.02, "Kiro credits are the real spend figure");

  const july = getSpend({ month: "2026-07" });
  assert.equal(july.totals.costedRequests, 0, "a model with no known rate must not inflate a total");
  assert.equal(july.totals.cost, 0);
});

test("an unattributed request is recorded as unknown, never guessed", () => {
  appendSpend(row({ ts: "2026-06-01T00:00:00.000Z", project: null, client: null }));
  const june = getSpend({ month: "2026-06" });
  assert.equal(june.byProject.unknown.requests, 1);
  assert.equal(june.byClient.unknown.requests, 1);
});

test("a torn last line does not lose the rest of the file", () => {
  // What a kill mid-append leaves behind.
  writeFileSync(spendPath(), '{"ts":"2026-05-01T00:00:00.000Z","tool":"codex","inputTokens":5}\n{"ts":"2026-05-0', { flag: "a" });
  const may = getSpend({ month: "2026-05" });
  assert.equal(may.totals.requests, 1);
  assert.equal(may.totals.inputTokens, 5);
});

test("project attribution: an explicit header wins", () => {
  assert.equal(
    projectFromRequest({ headers: { "x-agentos-project": "/srv/thing" }, body: {} }),
    "/srv/thing"
  );
});

test("project attribution: Codex's turn metadata carries the workspace path", () => {
  // Verified against real Codex 0.146 traffic on 2026-08-03: the header (and the
  // same JSON string inside client_metadata) holds workspaces keyed by absolute path.
  const turnMeta = JSON.stringify({
    session_id: "s1",
    workspaces: { "/home/amit/project/agentos-gateway": { latest_git_commit_hash: "abc", has_changes: false } },
  });
  assert.equal(
    projectFromRequest({ headers: { "x-codex-turn-metadata": turnMeta }, body: {} }),
    "/home/amit/project/agentos-gateway"
  );
  // Same value, body route (client_metadata mirrors the header).
  assert.equal(
    projectFromRequest({ headers: {}, body: { client_metadata: { "x-codex-turn-metadata": turnMeta } } }),
    "/home/amit/project/agentos-gateway"
  );
  // Malformed metadata must not throw, just fail to attribute.
  assert.equal(projectFromRequest({ headers: { "x-codex-turn-metadata": "not json" }, body: {} }), null);
  assert.equal(projectFromRequest({ headers: { "x-codex-turn-metadata": "{}" }, body: {} }), null);
});

test("project attribution: Claude Code's working directory is read from the system prompt", () => {
  const system = [
    { type: "text", text: "You are Claude Code." },
    { type: "text", text: "<env>\nWorking directory: /home/amit/project/trailmem\nIs directory a git repo: Yes\n</env>" },
  ];
  assert.equal(projectFromRequest({ headers: {}, body: { system } }), "/home/amit/project/trailmem");
  // String system prompts too.
  assert.equal(
    projectFromRequest({ headers: {}, body: { system: "working directory: /tmp/x" } }),
    "/tmp/x"
  );
  // Nothing identifying at all -> null, which is recorded as "unknown".
  assert.equal(projectFromRequest({ headers: {}, body: { system: "no path here" } }), null);
  assert.equal(projectFromRequest({ headers: {}, body: {} }), null);
});

test("client label is the user-agent's first token", () => {
  assert.equal(
    clientFromRequest({ headers: { "user-agent": "codex_exec/0.146.0 (Linux Mint 22.3.0; x86_64) gnome-terminal" } }),
    "codex_exec/0.146.0"
  );
  assert.equal(clientFromRequest({ headers: {} }), null);
});
