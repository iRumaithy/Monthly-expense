import { DurableObject } from "cloudflare:workers";
import core, { SyncRoom } from "./index.js";
export { SyncRoom };

const RELEASE_SYSTEM_VERSION = "7.1.0";
const CANDIDATE_VERSION = "7.1.0";
const CANDIDATE_NOTES_AR = "نظام اعتماد التحديثات من المالك أولًا + إشعارات فورية داخل التطبيق وخارجه.";
const CANDIDATE_NOTES_EN = "Owner-first release approval with instant in-app and system push notifications.";
const LEGACY_STABLE_VERSION = "7.0.6";
const APP_HEADER = "x-monthly-expense-app";

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}
function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function encJson(v) {
  return b64url(new TextEncoder().encode(JSON.stringify(v)));
}
async function sha256Text(v) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(v || "")));
  return b64url(d);
}
function versionCmp(a, b) {
  const aa = String(a || "0").split(".").map(n => Number(n) || 0);
  const bb = String(b || "0").split(".").map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] || 0, y = bb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function sameOriginMutationAllowed(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return request.headers.get(APP_HEADER) === "1";
}
function hubStub(env) {
  return env.UPDATE_HUB.get(env.UPDATE_HUB.idFromName("monthly-expense-global-release-hub"));
}
async function hubRequest(env, path, init = {}) {
  const r = await hubStub(env).fetch(new Request(`https://release-hub${path}`, init));
  return r;
}
async function hubJson(env, path, init = {}) {
  const r = await hubRequest(env, path, init);
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { response: r, body };
}
async function authMe(request, env) {
  try {
    const u = new URL("/api/auth/me", request.url);
    const headers = new Headers();
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    const r = await core.fetch(new Request(u, { method: "GET", headers }), env);
    if (!r.ok) return { authenticated: false };
    return await r.json();
  } catch (_) {
    return { authenticated: false };
  }
}
async function isSuperAdmin(request, env) {
  const me = await authMe(request, env);
  return !!(me?.authenticated && me?.user?.role === "super_admin");
}
async function assetExists(request, env, version, file) {
  try {
    const u = new URL(`/releases/${encodeURIComponent(version)}/${file}`, request.url);
    const r = await env.ASSETS.fetch(new Request(u, { method: "GET" }));
    return r.ok;
  } catch (_) { return false; }
}
async function ensureDefaultCandidate(request, env) {
  const { body } = await hubJson(env, "/state");
  const state = body?.state || {};
  if (state.stableVersion === CANDIDATE_VERSION || state.candidateVersion) return state;
  if (!(await assetExists(request, env, CANDIDATE_VERSION, "index.html"))) return state;
  if (!(await assetExists(request, env, CANDIDATE_VERSION, "sw.js"))) return state;
  const staged = await hubJson(env, "/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: CANDIDATE_VERSION,
      notesAr: CANDIDATE_NOTES_AR,
      notesEn: CANDIDATE_NOTES_EN,
      stagedAt: new Date().toISOString(),
    }),
  });
  return staged.body?.state || state;
}
async function currentReleaseState(request, env) {
  await ensureDefaultCandidate(request, env);
  const { body } = await hubJson(env, "/state");
  return body?.state || { stableVersion: LEGACY_STABLE_VERSION, status: "stable" };
}
function releaseAssetPath(version, file) {
  if (!version || version === LEGACY_STABLE_VERSION) return file === "sw.js" ? "/sw.js" : "/index.html";
  return `/releases/${encodeURIComponent(version)}/${file}`;
}
async function serveReleaseAsset(request, env, file) {
  const url = new URL(request.url);
  if (url.searchParams.has("__raw_base")) {
    const raw = new URL(file === "sw.js" ? "/sw.js" : "/index.html", url);
    raw.search = "";
    return env.ASSETS.fetch(new Request(raw, { method: "GET", headers: request.headers }));
  }

  const state = await currentReleaseState(request, env);
  let owner = false;
  if (state.candidateVersion && state.status === "owner_testing") owner = await isSuperAdmin(request, env);

  const explicitCandidate = url.searchParams.get("candidate");
  let version = state.stableVersion || LEGACY_STABLE_VERSION;
  if (owner && state.candidateVersion && state.status === "owner_testing") version = state.candidateVersion;
  if (explicitCandidate && owner && explicitCandidate === state.candidateVersion) version = explicitCandidate;

  const assetUrl = new URL(releaseAssetPath(version, file), url);
  assetUrl.search = "";
  const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET", headers: request.headers }));
  if (response.ok) return response;

  // Safety fallback: never break the app because a staged asset is missing.
  const fallback = new URL(file === "sw.js" ? "/sw.js" : "/index.html", url);
  fallback.search = "";
  return env.ASSETS.fetch(new Request(fallback, { method: "GET", headers: request.headers }));
}
async function handleUpdateApi(request, env, url) {
  const p = url.pathname;
  const state = await currentReleaseState(request, env);

  if (p === "/api/update/status" && request.method === "GET") {
    const owner = state.candidateVersion && state.status === "owner_testing" ? await isSuperAdmin(request, env) : false;
    const current = url.searchParams.get("current") || "";
    const availableVersion = owner && state.candidateVersion && state.status === "owner_testing"
      ? state.candidateVersion
      : (state.stableVersion || LEGACY_STABLE_VERSION);
    return json({
      ok: true,
      systemVersion: RELEASE_SYSTEM_VERSION,
      channel: owner && state.candidateVersion && state.status === "owner_testing" ? "owner_testing" : "stable",
      currentVersion: current,
      availableVersion,
      updateAvailable: !!current && versionCmp(availableVersion, current) > 0,
      stableVersion: state.stableVersion || LEGACY_STABLE_VERSION,
      candidateVersion: owner ? (state.candidateVersion || null) : null,
      candidateNotes: owner ? (state.candidateNotes || null) : null,
      approvedAt: state.approvedAt || null,
      stagedAt: owner ? (state.stagedAt || null) : null,
      pushEnabled: true,
      lastPushStats: owner ? (state.lastPushStats || null) : null,
    });
  }

  if (p === "/api/update/push-key" && request.method === "GET") {
    const { response, body } = await hubJson(env, "/push-key");
    return json(body || { ok: false, error: "PUSH_KEY_FAILED" }, response.status);
  }

  if (p === "/api/update/subscribe" && request.method === "POST") {
    if (!sameOriginMutationAllowed(request)) return json({ ok: false, error: "BAD_REQUEST_ORIGIN" }, 403);
    const b = await request.json().catch(() => ({}));
    if (!b?.subscription?.endpoint) return json({ ok: false, error: "INVALID_SUBSCRIPTION" }, 400);
    const me = await authMe(request, env);
    const payload = {
      subscription: b.subscription,
      userId: me?.authenticated ? (me.user?.id || null) : null,
      accountId: me?.authenticated ? (me.session?.accountId || null) : null,
      role: me?.authenticated ? (me.user?.role || null) : null,
      userAgent: request.headers.get("user-agent") || "",
      updatedAt: new Date().toISOString(),
    };
    const { response, body } = await hubJson(env, "/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    return json(body || { ok: false }, response.status);
  }

  if (p === "/api/update/unsubscribe" && request.method === "POST") {
    if (!sameOriginMutationAllowed(request)) return json({ ok: false, error: "BAD_REQUEST_ORIGIN" }, 403);
    const b = await request.json().catch(() => ({}));
    const { response, body } = await hubJson(env, "/unsubscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: b.endpoint || "" }),
    });
    return json(body || { ok: false }, response.status);
  }

  if (p === "/api/update/approve" && request.method === "POST") {
    if (!sameOriginMutationAllowed(request)) return json({ ok: false, error: "BAD_REQUEST_ORIGIN" }, 403);
    if (!(await isSuperAdmin(request, env))) return json({ ok: false, error: "FORBIDDEN" }, 403);
    const fresh = await currentReleaseState(request, env);
    if (!fresh.candidateVersion || fresh.status !== "owner_testing") return json({ ok: false, error: "NO_CANDIDATE" }, 409);
    const indexOk = await assetExists(request, env, fresh.candidateVersion, "index.html");
    const swOk = await assetExists(request, env, fresh.candidateVersion, "sw.js");
    if (!indexOk || !swOk) return json({ ok: false, error: "CANDIDATE_ASSETS_MISSING" }, 409);
    const { response, body } = await hubJson(env, "/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approvedBy: "super_admin",
        approvedAt: new Date().toISOString(),
        subjectOrigin: new URL(request.url).origin,
      }),
    });
    return json(body || { ok: false }, response.status);
  }

  if (p === "/api/update/reject" && request.method === "POST") {
    if (!sameOriginMutationAllowed(request)) return json({ ok: false, error: "BAD_REQUEST_ORIGIN" }, 403);
    if (!(await isSuperAdmin(request, env))) return json({ ok: false, error: "FORBIDDEN" }, 403);
    const { response, body } = await hubJson(env, "/reject", { method: "POST" });
    return json(body || { ok: false }, response.status);
  }

  if (p === "/api/update/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return hubRequest(env, "/ws", { headers: request.headers });
  }

  return json({ ok: false, error: "NOT_FOUND" }, 404);
}

function derToJose(sig) {
  const b = new Uint8Array(sig);
  if (b.length === 64) return b;
  if (b[0] !== 0x30) return b;
  let p = 2;
  if (b[1] & 0x80) p = 2 + (b[1] & 0x7f);
  if (b[p++] !== 0x02) return b;
  const rLen = b[p++];
  let r = b.slice(p, p + rLen); p += rLen;
  if (b[p++] !== 0x02) return b;
  const sLen = b[p++];
  let s = b.slice(p, p + sLen);
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  const out = new Uint8Array(64);
  out.set(r.slice(-32), 32 - Math.min(32, r.length));
  out.set(s.slice(-32), 64 - Math.min(32, s.length));
  return out;
}

export class ReleaseHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async getState() {
    let s = await this.ctx.storage.get("release:state");
    if (!s) {
      s = {
        stableVersion: LEGACY_STABLE_VERSION,
        candidateVersion: null,
        candidateNotes: null,
        status: "stable",
        approvedAt: null,
        stagedAt: null,
        lastPushStats: null,
      };
      await this.ctx.storage.put("release:state", s);
    }
    return s;
  }
  async putState(s) {
    await this.ctx.storage.put("release:state", s);
    return s;
  }
  async ensureVapid() {
    let v = await this.ctx.storage.get("push:vapid");
    if (v?.privateJwk && v?.publicKey) return v;
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
    const rawPublic = await crypto.subtle.exportKey("raw", keys.publicKey);
    v = { privateJwk, publicKey: b64url(rawPublic), createdAt: new Date().toISOString() };
    await this.ctx.storage.put("push:vapid", v);
    return v;
  }
  async makeVapidJwt(endpoint, subjectOrigin) {
    const vapid = await this.ensureVapid();
    const aud = new URL(endpoint).origin;
    const now = Math.floor(Date.now() / 1000);
    const header = encJson({ typ: "JWT", alg: "ES256" });
    const payload = encJson({ aud, exp: now + 12 * 60 * 60, sub: subjectOrigin });
    const input = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );
    const signed = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)
    );
    return { jwt: `${input}.${b64url(derToJose(signed))}`, publicKey: vapid.publicKey };
  }
  async sendEmptyPush(endpoint, subjectOrigin) {
    const { jwt, publicKey } = await this.makeVapidJwt(endpoint, subjectOrigin);
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Urgency: "high",
        Authorization: `vapid t=${jwt}, k=${publicKey}`,
      },
    });
    return r;
  }
  async pushAll(release, subjectOrigin) {
    const list = await this.ctx.storage.list({ prefix: "push:sub:" });
    let sent = 0, failed = 0, removed = 0;
    const entries = [...list.entries()];
    const chunks = [];
    for (let i = 0; i < entries.length; i += 20) chunks.push(entries.slice(i, i + 20));
    for (const chunk of chunks) {
      const results = await Promise.allSettled(chunk.map(async ([key, sub]) => {
        const endpoint = sub?.subscription?.endpoint;
        if (!endpoint) { await this.ctx.storage.delete(key); removed++; return; }
        const r = await this.sendEmptyPush(endpoint, subjectOrigin);
        if (r.status === 404 || r.status === 410) { await this.ctx.storage.delete(key); removed++; return; }
        if (r.ok || r.status === 201 || r.status === 202) sent++; else failed++;
      }));
      for (const rr of results) if (rr.status === "rejected") failed++;
    }
    const state = await this.getState();
    state.lastPushStats = { version: release.version, sent, failed, removed, attempted: entries.length, at: new Date().toISOString() };
    await this.putState(state);
    return state.lastPushStats;
  }
  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch (_) {}
    }
  }
  webSocketMessage(ws, message) {
    if (String(message) === "ping") { try { ws.send("pong"); } catch (_) {} }
  }
  webSocketClose() {}
  webSocketError() {}

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/state" && request.method === "GET") return json({ ok: true, state: await this.getState() });

    if (p === "/stage" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const s = await this.getState();
      if (!b.version || versionCmp(b.version, s.stableVersion) <= 0) return json({ ok: true, state: s });
      if (s.candidateVersion === b.version && s.status === "owner_testing") return json({ ok: true, state: s });
      s.candidateVersion = String(b.version);
      s.candidateNotes = { ar: b.notesAr || "", en: b.notesEn || "" };
      s.status = "owner_testing";
      s.stagedAt = b.stagedAt || new Date().toISOString();
      await this.putState(s);
      return json({ ok: true, state: s });
    }

    if (p === "/approve" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const s = await this.getState();
      if (!s.candidateVersion || s.status !== "owner_testing") return json({ ok: false, error: "NO_CANDIDATE" }, 409);
      const release = { version: s.candidateVersion, notes: s.candidateNotes || null };
      s.stableVersion = s.candidateVersion;
      s.candidateVersion = null;
      s.candidateNotes = null;
      s.status = "stable";
      s.approvedAt = b.approvedAt || new Date().toISOString();
      s.stagedAt = null;
      await this.putState(s);
      this.broadcast({ type: "release-approved", version: release.version, notes: release.notes, approvedAt: s.approvedAt });
      const subjectOrigin = String(b.subjectOrigin || "https://example.com");
      this.ctx.waitUntil(this.pushAll(release, subjectOrigin).catch(() => {}));
      return json({ ok: true, version: release.version, approvedAt: s.approvedAt, pushQueued: true, state: s });
    }

    if (p === "/reject" && request.method === "POST") {
      const s = await this.getState();
      const rejected = s.candidateVersion;
      s.candidateVersion = null;
      s.candidateNotes = null;
      s.status = "stable";
      s.stagedAt = null;
      await this.putState(s);
      return json({ ok: true, rejectedVersion: rejected, state: s });
    }

    if (p === "/push-key" && request.method === "GET") {
      const v = await this.ensureVapid();
      return json({ ok: true, publicKey: v.publicKey });
    }

    if (p === "/subscribe" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const endpoint = b?.subscription?.endpoint;
      if (!endpoint) return json({ ok: false, error: "INVALID_SUBSCRIPTION" }, 400);
      const key = `push:sub:${await sha256Text(endpoint)}`;
      await this.ctx.storage.put(key, { ...b, createdAt: b.createdAt || new Date().toISOString() });
      return json({ ok: true });
    }

    if (p === "/unsubscribe" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.endpoint) return json({ ok: true });
      await this.ctx.storage.delete(`push:sub:${await sha256Text(b.endpoint)}`);
      return json({ ok: true });
    }

    if (p === "/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ ok: false, error: "NOT_FOUND" }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/update/")) return await handleUpdateApi(request, env, url);

      // These three routes are release-gated. A candidate is served only to the signed-in super_admin.
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return await serveReleaseAsset(request, env, "index.html");
      }
      if (request.method === "GET" && url.pathname === "/sw.js") {
        return await serveReleaseAsset(request, env, "sw.js");
      }

      return await core.fetch(request, env, ctx);
    } catch (e) {
      console.error("Release gate error", e);
      return core.fetch(request, env, ctx);
    }
  },
};
