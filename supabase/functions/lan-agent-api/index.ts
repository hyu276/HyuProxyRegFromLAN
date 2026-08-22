import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceRole, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_BODY_BYTES = 256 * 1024;
const COMMAND_LEASE_MS = 60_000;
const COMMAND_MAX_ATTEMPTS = 3;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

class RequestTooLargeError extends Error {}

async function readJsonBody(req: Request) {
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIp(req: Request) {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

function readBearer(req: Request) {
  const value = req.headers.get("authorization") || "";
  return value.toLowerCase().startsWith("bearer ")
    ? value.slice(7).trim()
    : null;
}

function isPrivateIpv4(value: string) {
  const parts = value.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailscaleIpv4(value: string) {
  const parts = value.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function clampLatency(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(600_000, Math.max(0, Math.round(parsed)))
    : null;
}

async function authenticateAgent(req: Request) {
  const token = readBearer(req);
  if (!token || token.length < 24) return null;
  const tokenHash = await sha256Hex(token);
  const { data, error } = await admin
    .from("lan_agent_credentials")
    .select("agent_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !data) return null;
  return { agentId: data.agent_id as string };
}

async function recycleExpiredCommandLeases(agentId: string, now: string) {
  const cutoff = new Date(Date.now() - COMMAND_LEASE_MS).toISOString();

  const { error: failError } = await admin
    .from("lan_agent_commands")
    .update({
      status: "failed",
      completed_at: now,
      error_message: "command delivery timed out after repeated retries",
    })
    .eq("agent_id", agentId)
    .eq("status", "acknowledged")
    .lt("acknowledged_at", cutoff)
    .gte("attempt_count", COMMAND_MAX_ATTEMPTS);
  if (failError) throw failError;

  const { error: retryError } = await admin
    .from("lan_agent_commands")
    .update({ status: "queued", acknowledged_at: null, error_message: null })
    .eq("agent_id", agentId)
    .eq("status", "acknowledged")
    .lt("acknowledged_at", cutoff)
    .lt("attempt_count", COMMAND_MAX_ATTEMPTS);
  if (retryError) throw retryError;
}

async function leaseQueuedCommands(agentId: string, now: string) {
  const { data: queued, error } = await admin
    .from("lan_agent_commands")
    .select("id,command_type,payload,created_at,attempt_count")
    .eq("agent_id", agentId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw error;

  const deliverable = [];
  for (const command of queued || []) {
    const nextAttempt = Number(command.attempt_count || 0) + 1;
    const { data: leased, error: leaseError } = await admin
      .from("lan_agent_commands")
      .update({ status: "acknowledged", acknowledged_at: now, attempt_count: nextAttempt })
      .eq("id", command.id)
      .eq("agent_id", agentId)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (leaseError) throw leaseError;
    if (leased) {
      deliverable.push({
        id: command.id,
        command_type: command.command_type,
        payload: command.payload,
        created_at: command.created_at,
      });
    }
  }
  return deliverable;
}

Deno.serve(async (req: Request) => {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json(413, { error: "request_too_large" });
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();

  try {
    if (req.method === "POST" && route === "pair") {
      const body = await readJsonBody(req);
      const pairingKey = String(body.pairing_key || "").trim();
      const tokenHash = String(body.token_hash || "").toLowerCase();
      if (!/^[0-9A-Fa-f]{12}$/.test(pairingKey) || !/^[0-9a-f]{64}$/.test(tokenHash)) {
        return json(400, { error: "invalid_pairing_payload" });
      }
      const name = String(body.name || "LAN Agent").trim().slice(0, 80) || "LAN Agent";
      const platform = String(body.platform || "").trim().slice(0, 80);
      const agentVersion = String(body.agent_version || "").trim().slice(0, 40);
      const capabilities = typeof body.capabilities === "object" && body.capabilities ? body.capabilities : {};
      const { data: agentId, error } = await admin.rpc("lan_claim_pairing", {
        p_pairing_key: pairingKey,
        p_agent_name: name,
        p_platform: platform,
        p_agent_version: agentVersion,
        p_capabilities: capabilities,
        p_token_hash: tokenHash,
      });
      if (error) {
        return json(401, { error: "pairing_failed", detail: "The pairing key is invalid, expired, or already used." });
      }
      const publicIp = getClientIp(req);
      if (publicIp) {
        const { error: ipError } = await admin
          .from("lan_agents")
          .update({ public_ip: publicIp, updated_at: new Date().toISOString() })
          .eq("id", agentId);
        if (ipError) return json(500, { error: "pairing_ip_update_failed", detail: ipError.message });
      }
      return json(200, { agent_id: agentId, paired: true });
    }

    if (req.method === "POST" && route === "heartbeat") {
      const auth = await authenticateAgent(req);
      if (!auth) return json(401, { error: "unauthorized_agent" });
      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      const rawLanIp = body.lan_ip ? String(body.lan_ip).trim() : "";
      const lanIp = isPrivateIpv4(rawLanIp) ? rawLanIp : null;
      const rawTailscaleIp = body.tailscale_ip ? String(body.tailscale_ip).trim() : "";
      const tailscaleIp = isTailscaleIpv4(rawTailscaleIp) ? rawTailscaleIp : null;
      const latencyMs = clampLatency(body.latency_ms);
      const cleanName = body.name ? String(body.name).trim().slice(0, 80) : "";
      const update: Record<string, unknown> = {
        status: "online",
        lan_ip: lanIp,
        tailscale_ip: tailscaleIp,
        public_ip: getClientIp(req),
        last_latency_ms: latencyMs,
        last_seen_at: now,
        updated_at: now,
      };
      if (cleanName) update.name = cleanName;
      if (body.agent_version) update.agent_version = String(body.agent_version).trim().slice(0, 40);
      const { error: agentError } = await admin.from("lan_agents").update(update).eq("id", auth.agentId);
      if (agentError) return json(500, { error: "agent_update_failed", detail: agentError.message });

      const snapshotComplete = body.proxy_snapshot_complete === true;
      if (!snapshotComplete) {
        const { error: staleError } = await admin
          .from("lan_proxies")
          .update({ healthy: false, updated_at: now })
          .eq("agent_id", auth.agentId);
        if (staleError) return json(500, { error: "proxy_stale_mark_failed", detail: staleError.message });
      }

      const proxies = Array.isArray(body.proxies) ? body.proxies.slice(0, 128) : [];
      const normalized = proxies
        .map((proxy: any) => {
          const host = String(proxy.host || lanIp || "").trim();
          return {
            agent_id: auth.agentId,
            host,
            port: Number(proxy.port),
            protocol: String(proxy.protocol || "").toLowerCase(),
            enabled: proxy.enabled !== false,
            healthy: proxy.healthy === true,
            latency_ms: clampLatency(proxy.latency_ms),
            last_checked_at: now,
            metadata: typeof proxy.metadata === "object" && proxy.metadata ? proxy.metadata : {},
            updated_at: now,
          };
        })
        .filter((proxy: any) =>
          isPrivateIpv4(proxy.host) &&
          Number.isInteger(proxy.port) &&
          proxy.port >= 1 &&
          proxy.port <= 65535 &&
          ["http", "socks5"].includes(proxy.protocol)
        );
      const keep = new Set(normalized.map((proxy: any) => `${proxy.host}|${proxy.port}|${proxy.protocol}`));
      if (normalized.length) {
        const { error: upsertError } = await admin
          .from("lan_proxies")
          .upsert(normalized, { onConflict: "agent_id,host,port,protocol" });
        if (upsertError) return json(500, { error: "proxy_upsert_failed", detail: upsertError.message });
      }
      if (snapshotComplete) {
        const { data: existing, error: existingError } = await admin
          .from("lan_proxies")
          .select("id,host,port,protocol")
          .eq("agent_id", auth.agentId);
        if (existingError) return json(500, { error: "proxy_read_failed", detail: existingError.message });
        const staleIds = (existing || [])
          .filter((proxy: any) => !keep.has(`${proxy.host}|${proxy.port}|${proxy.protocol}`))
          .map((proxy: any) => proxy.id);
        if (staleIds.length) {
          const { error: deleteError } = await admin.from("lan_proxies").delete().in("id", staleIds);
          if (deleteError) return json(500, { error: "proxy_cleanup_failed", detail: deleteError.message });
        }
      }
      await recycleExpiredCommandLeases(auth.agentId, now);
      const commands = await leaseQueuedCommands(auth.agentId, now);
      return json(200, { ok: true, server_time: now, commands });
    }

    if (req.method === "POST" && route === "command-result") {
      const auth = await authenticateAgent(req);
      if (!auth) return json(401, { error: "unauthorized_agent" });
      const body = await readJsonBody(req);
      const commandId = String(body.command_id || "");
      if (!commandId) return json(400, { error: "missing_command_id" });
      const { data: command, error: commandError } = await admin
        .from("lan_agent_commands")
        .select("id,status")
        .eq("id", commandId)
        .eq("agent_id", auth.agentId)
        .maybeSingle();
      if (commandError) return json(500, { error: "command_lookup_failed", detail: commandError.message });
      if (!command) return json(404, { error: "command_not_found" });
      const ok = body.ok === true;
      const { error: updateError } = await admin
        .from("lan_agent_commands")
        .update({
          status: ok ? "completed" : "failed",
          completed_at: new Date().toISOString(),
          error_message: ok ? null : String(body.error || "agent command failed").slice(0, 500),
        })
        .eq("id", commandId)
        .eq("agent_id", auth.agentId);
      if (updateError) return json(500, { error: "command_update_failed", detail: updateError.message });
      return json(200, { ok: true });
    }

    return json(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RequestTooLargeError) return json(413, { error: "request_too_large" });
    if (error instanceof SyntaxError) return json(400, { error: "invalid_json" });
    return json(500, {
      error: "internal_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});
