import { randomBytes, timingSafeEqual } from "node:crypto";
import { envGet, envSet } from "../config/envStore.js";

// The dashboard can read, rotate and delete provider API keys, so it must not be
// reachable without a secret. Token lives in data/.env (mode 0600) and is
// generated on first boot so the gateway is never accidentally left open.
export function adminToken() {
  let token = envGet("AGENTOS_ADMIN_TOKEN");
  if (!token) {
    token = randomBytes(16).toString("hex");
    envSet("AGENTOS_ADMIN_TOKEN", token);
  }
  return token;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// HTTP Basic (username ignored, password = admin token) rather than a bearer
// header: a plain browser can then reach /admin via its native prompt, with no
// login page, cookie or session code to maintain.
export function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    const password = colon === -1 ? "" : decoded.slice(colon + 1);
    if (safeEqual(password, adminToken())) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="agentos-gateway"');
  res.status(401).json({ error: "admin token required" });
}
