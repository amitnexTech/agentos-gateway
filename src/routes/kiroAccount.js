// Kiro account management — add/list accounts authenticated by a Kiro API key (ksk_).
//
// Adding an account is a single step: paste the key. The profile behind the key
// identifies the Kiro account, and the model list is fetched live.

import { Router } from "express";
import { randomBytes } from "node:crypto";
import {
  addProvider,
  setProviderModels,
  updateProvider,
  listProviders,
  getProvider,
  deleteProvider,
} from "../config/keysStore.js";
import { envSet, envDelete, envGet } from "../config/envStore.js";
import { getProfile, listModels } from "../kiro/api.js";
import { DEFAULT_REGION } from "../kiro/config.js";
import { ApiError } from "../lib/errors.js";

export const kiroAccountRouter = Router();

function newKeyRef() {
  return `AGENTOS_KEY_${randomBytes(6).toString("hex").toUpperCase()}`;
}

function kiroProviders() {
  return listProviders().filter((p) => p.type === "kiro");
}

// --- POST /admin/kiro/account --- Add an account from an API key
kiroAccountRouter.post("/kiro/account", async (req, res, next) => {
  try {
    const { name, apiKey, creditBudget, region } = req.body || {};

    if (!apiKey || typeof apiKey !== "string") {
      throw new ApiError(400, "apiKey is required");
    }
    if (creditBudget !== undefined && creditBudget !== null && creditBudget !== "") {
      if (typeof creditBudget !== "number" || creditBudget < 0) {
        throw new ApiError(400, "creditBudget must be a positive number");
      }
    }

    const key = apiKey.trim();
    const accountRegion = region || DEFAULT_REGION;

    // Validate the key and identify the account it belongs to.
    let profile;
    try {
      profile = await getProfile(key, accountRegion);
    } catch (err) {
      throw new ApiError(400, `API key rejected by Kiro: ${err.message}`);
    }
    if (!profile.arn) {
      throw new ApiError(400, "Kiro did not return a profile for this key");
    }

    // Reject a key for an account that is already configured.
    const duplicate = kiroProviders().find((p) => p.profileArn === profile.arn);
    if (duplicate) {
      throw new ApiError(
        409,
        `This Kiro account is already added as "${duplicate.name}" (profile ${profile.arn})`
      );
    }

    const keyRef = newKeyRef();
    envSet(keyRef, key);

    const provider = addProvider({
      name: name?.trim() ? `Kiro: ${name.trim()}` : `Kiro: ${profile.accountId || "account"}`,
      type: "kiro",
      baseUrl: "",
      apiKeyRef: keyRef,
      region: accountRegion,
      creditBudget: typeof creditBudget === "number" ? creditBudget : undefined,
    });

    // Record which Kiro account this provider is bound to (used for dedup + display).
    updateProvider(provider.id, { profileArn: profile.arn, accountId: profile.accountId });

    // Populate the model list. Non-fatal: it can be refreshed from the dashboard.
    let models = [];
    try {
      models = await listModels(key, accountRegion);
      if (models.length) setProviderModels(provider.id, models.map((m) => m.id));
    } catch (err) {
      console.warn(`[kiro-account] model fetch failed for ${provider.name}: ${err.message}`);
    }

    res.status(201).json({
      ok: true,
      provider: {
        id: provider.id,
        name: provider.name,
        region: accountRegion,
        profileArn: profile.arn,
        accountId: profile.accountId,
        creditBudget: provider.creditBudget || null,
        models: models.map((m) => m.id),
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- PUT /admin/kiro/account/:id --- Update name, budget, or rotate the key
kiroAccountRouter.put("/kiro/account/:id", async (req, res, next) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider || provider.type !== "kiro") throw new ApiError(404, "Kiro account not found");

    const { name, apiKey, creditBudget, resetCredits } = req.body || {};
    const patch = {};

    if (name?.trim()) patch.name = name.trim().startsWith("Kiro:") ? name.trim() : `Kiro: ${name.trim()}`;
    if (creditBudget !== undefined) {
      if (creditBudget === null || creditBudget === "") patch.creditBudget = null;
      else if (typeof creditBudget === "number" && creditBudget >= 0) patch.creditBudget = creditBudget;
      else throw new ApiError(400, "creditBudget must be a positive number or null");
    }
    if (resetCredits) patch.usedCredits = 0;

    if (apiKey?.trim()) {
      const key = apiKey.trim();
      // Verify the replacement key points at the same Kiro account.
      let profile;
      try {
        profile = await getProfile(key, provider.region || DEFAULT_REGION);
      } catch (err) {
        throw new ApiError(400, `API key rejected by Kiro: ${err.message}`);
      }
      if (provider.profileArn && profile.arn !== provider.profileArn) {
        throw new ApiError(
          400,
          `This key belongs to a different Kiro account (${profile.arn}). Add it as a new account instead.`
        );
      }
      const keyRef = provider.apiKeyRef || newKeyRef();
      envSet(keyRef, key);
      patch.apiKeyRef = keyRef;
      patch.profileArn = profile.arn;
    }

    res.json({ ok: true, provider: updateProvider(provider.id, patch) });
  } catch (err) {
    next(err);
  }
});

// --- DELETE /admin/kiro/account/:id --- Remove an account and its stored key
kiroAccountRouter.delete("/kiro/account/:id", (req, res, next) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider || provider.type !== "kiro") throw new ApiError(404, "Kiro account not found");
    if (provider.apiKeyRef) envDelete(provider.apiKeyRef);
    deleteProvider(provider.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- GET /admin/kiro/accounts --- List accounts with credit usage
kiroAccountRouter.get("/kiro/accounts", (_req, res) => {
  const accounts = kiroProviders().map((p) => {
    const used = p.usedCredits || 0;
    const budget = p.creditBudget || null;
    return {
      id: p.id,
      name: p.name,
      region: p.region || DEFAULT_REGION,
      profileArn: p.profileArn || null,
      accountId: p.accountId || null,
      creditBudget: budget,
      usedCredits: used,
      remainingCredits: budget ? Math.max(0, Math.round((budget - used) * 1000000) / 1000000) : null,
      usedPercent: budget ? Math.min(100, Math.round((used / budget) * 100)) : null,
      hasKey: Boolean(p.apiKeyRef && envGet(p.apiKeyRef)),
      enabled: p.enabled !== false,
      status: p.status || "untested",
    };
  });
  res.json(accounts);
});
