import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function getClientIp(req: Request) {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}
function readBearer(req: Request) {
  const value = req.headers.get("authorization") || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : null;
}
async function authenticateAgent(req: Request) {
  const token = readBearer(req);
  if (!token || token.length < 24) return null;
  const tokenHash = await sha256Hex(token);
  const { data, error } = await admin.from("lan_agent_credentials").select("agent_id").eq("token_hash", tokenHash).maybeSingle();
  if (error || !data) return null;
  return { agentId: data.agent_id as string };
}

Deno.serve(async (req: Request) => {
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (req.method === "POST" && route === "pair") {
      const body = await req.json();
      const pairingKey = String(body.pairing_key || "").trim();
      const tokenHash = String(body.token_hash || "").toLowerCase();
      if (!/^[0-9A-Fa-f]{12}$/.test(pairingKey) || !/^[0-9a-f]{64}$/.test(tokenHash)) return json(400, { error: "invalid_pairing_payload" });
      const { data: agentId, error } = await admin.rpc("lan_claim_pairing", {
        p_pairing_key: pairingKey,
        p_agent_name: String(body.name || "LAN Agent").trim(),
        p_platform: String(body.platform || "").trim(),
        p_agent_version: String(body.agent_version || "").trim(),
        p_capabilities: typeof body.capabilities === "object" && body.capabilities ? body.capabilities : {},
        p_token_hash: tokenHash,
      });
      if (error) return json(401, { error: "pairing_failed", detail: error.message });
      const publicIp = getClientIp(req);
      if (publicIp) await admin.from("lan_agents").update({ public_ip: publicIp, updated_at: new Date().toISOString() }).eq("id", agentId);
      return json(200, { agent_id: agentId, paired: true });
    }

    if (req.method === "POST" && route === "heartbeat") {
      const auth = await authenticateAgent(req);
      if (!auth) return json(401, { error: "unauthorized_agent" });
      const body = await req.json();
      const now = new Date().toISOString();
      const lanIp = body.lan_ip ? String(body.lan_ip) : null;
      const latencyMs = Number.isFinite(Number(body.latency_ms)) ? Math.max(0, Math.round(Number(body.latency_ms))) : null;
      const update: Record<string, unknown> = {
        status: "online", lan_ip: lanIp, tailscale_ip: body.tailscale_ip ? String(body.tailscale_ip) : null,
        public_ip: getClientIp(req), last_latency_ms: latencyMs, last_seen_at: now, updated_at: now,
        agent_version: body.agent_version ? String(body.agent_version).slice(0, 40) : undefined,
      };
      if (body.name) update.name = String(body.name).trim().slice(0, 80);
      const { error: agentError } = await admin.from("lan_agents").update(update).eq("id", auth.agentId);
      if (agentError) return json(500, { error: "agent_update_failed", detail: agentError.message });

      const proxies = Array.isArray(body.proxies) ? body.proxies.slice(0, 128) : [];
      const normalized = proxies.map((p: any) => ({
        agent_id: auth.agentId, host: String(p.host || lanIp || ""), port: Number(p.port), protocol: String(p.protocol || "").toLowerCase(),
        enabled: p.enabled !== false, healthy: p.healthy === true,
        latency_ms: Number.isFinite(Number(p.latency_ms)) ? Math.max(0, Math.round(Number(p.latency_ms))) : null,
        last_checked_at: now, metadata: typeof p.metadata === "object" && p.metadata ? p.metadata : {}, updated_at: now,
      })).filter((p: any) => p.host && p.port >= 1 && p.port <= 65535 && ["http", "https", "socks5"].includes(p.protocol));

      const keep = new Set(normalized.map((p: any) => `${p.host}|${p.port}|${p.protocol}`));
      if (normalized.length) {
        const { error } = await admin.from("lan_proxies").upsert(normalized, { onConflict: "agent_id,host,port,protocol" });
        if (error) return json(500, { error: "proxy_upsert_failed", detail: error.message });
      }
      const { data: existing } = await admin.from("lan_proxies").select("id,host,port,protocol").eq("agent_id", auth.agentId);
      const staleIds = (existing || []).filter((p: any) => !keep.has(`${p.host}|${p.port}|${p.protocol}`)).map((p: any) => p.id);
      if (staleIds.length) await admin.from("lan_proxies").delete().in("id", staleIds);

      const { data: commands } = await admin.from("lan_agent_commands").select("id,command_type,payload,created_at").eq("agent_id", auth.agentId).eq("status", "queued").order("created_at", { ascending: true }).limit(20);
      if (commands?.length) await admin.from("lan_agent_commands").update({ status: "acknowledged", acknowledged_at: now }).in("id", commands.map((c: any) => c.id));
      return json(200, { ok: true, server_time: now, commands: commands || [] });
    }

    if (req.method === "POST" && route === "command-result") {
      const auth = await authenticateAgent(req);
      if (!auth) return json(401, { error: "unauthorized_agent" });
      const body = await req.json();
      const commandId = String(body.command_id || "");
      if (!commandId) return json(400, { error: "missing_command_id" });
      const { data: command } = await admin.from("lan_agent_commands").select("id").eq("id", commandId).eq("agent_id", auth.agentId).maybeSingle();
      if (!command) return json(404, { error: "command_not_found" });
      const ok = body.ok === true;
      await admin.from("lan_agent_commands").update({ status: ok ? "completed" : "failed", completed_at: new Date().toISOString(), error_message: ok ? null : String(body.error || "agent command failed").slice(0, 500) }).eq("id", commandId);
      return json(200, { ok: true });
    }
    return json(404, { error: "not_found" });
  } catch (error) {
    return json(500, { error: "internal_error", detail: error instanceof Error ? error.message : String(error) });
  }
});
