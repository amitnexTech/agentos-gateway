// Thin Kiro API helper: header construction + management-plane calls.

import { randomUUID } from "node:crypto";
import {
  ORIGIN,
  TARGET_CHAT,
  TARGET_LIST_MODELS,
  TARGET_GET_PROFILE,
  USER_AGENT,
  X_AMZ_USER_AGENT,
  getManagementHost,
} from "./config.js";

/**
 * Headers for any Kiro API call authenticated with a ksk_ API key.
 * Every field here is load-bearing — see config.js for why.
 */
export function kiroHeaders(apiKey, target) {
  return {
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": target,
    "User-Agent": USER_AGENT,
    "x-amz-user-agent": X_AMZ_USER_AGENT,
    "x-amzn-codewhisperer-optout": "false",
    tokentype: "API_KEY",
    Authorization: `Bearer ${apiKey}`,
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": randomUUID(),
    Accept: "*/*",
  };
}

export function chatHeaders(apiKey) {
  return kiroHeaders(apiKey, TARGET_CHAT);
}

async function managementCall(apiKey, region, target, body, query = "") {
  const url = `${getManagementHost(region)}/${query}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: kiroHeaders(apiKey, target),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Kiro ${target} failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Live model list. This is the only endpoint that reports newly released models
 * (the runtime host has no model-list operation at all).
 */
export async function listModels(apiKey, region) {
  const data = await managementCall(
    apiKey,
    region,
    TARGET_LIST_MODELS,
    { origin: ORIGIN },
    `?origin=${ORIGIN}`
  );
  return (data.models || [])
    .map((m) => ({ id: m.modelId || m.id }))
    .filter((m) => m.id);
}

/**
 * Profile behind the API key — used to identify which Kiro account a key belongs to.
 */
export async function getProfile(apiKey, region) {
  const data = await managementCall(apiKey, region, TARGET_GET_PROFILE, {});
  const profile = data.profile || {};
  const arn = profile.arn || null;
  let accountId = null;
  if (arn) {
    const parts = arn.split(":");
    if (parts.length >= 5) accountId = parts[4] || null;
  }
  return { arn, accountId, profileName: profile.profileName || null };
}
