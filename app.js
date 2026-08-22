const SUPABASE_URL = 'https://zkrhwqgmynbbmoktokdq.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Fqcxk9-U1qalClQZjKcrhA_U822LTIq';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

const els = Object.fromEntries(['authView','dashboardView','authForm','emailInput','passwordInput','signUpBtn','signOutBtn','authMessage','connectionPill','generatePairingBtn','pairingEmpty','pairingActive','pairingCode','pairingCountdown','copyPairingBtn','refreshBtn','agentsEmpty','agentsList','statAgents','statProxies','statHealthy','statRealtime','agentTemplate'].map(id => [id, document.getElementById(id)]));
let currentUser = null, agents = [], proxies = [], realtimeChannel = null, pairingTimer = null, pairingExpiresAt = null;

function setAuthMessage(message, error = false) { els.authMessage.textContent = message || ''; els.authMessage.classList.toggle('error', error); }
function fmtIp(value) { return value || '—'; }
function isOnline(agent) { return !!agent.last_seen_at && Date.now() - new Date(agent.last_seen_at).getTime() < 30000; }
function ago(value) { if (!value) return 'never'; const s = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

async function loadRegistry() {
  if (!currentUser) return;
  const [{ data: agentData, error: aErr }, { data: proxyData, error: pErr }] = await Promise.all([
    sb.from('lan_agents').select('*').order('created_at', { ascending: false }),
    sb.from('lan_proxies').select('*').order('created_at', { ascending: true })
  ]);
  if (aErr || pErr) { els.connectionPill.textContent = 'SUPABASE · ERROR'; els.connectionPill.classList.add('offline'); console.error(aErr || pErr); return; }
  agents = agentData || []; proxies = proxyData || []; els.connectionPill.textContent = 'SUPABASE · CONNECTED'; els.connectionPill.classList.remove('offline','muted'); renderRegistry();
}

function renderRegistry() {
  els.statAgents.textContent = agents.filter(isOnline).length;
  els.statProxies.textContent = proxies.length;
  els.statHealthy.textContent = proxies.filter(p => p.healthy && p.enabled).length;
  els.agentsEmpty.classList.toggle('hidden', agents.length > 0);
  els.agentsList.replaceChildren();
  for (const agent of agents) {
    const node = els.agentTemplate.content.cloneNode(true); const online = isOnline(agent);
    node.querySelector('.agent-name').textContent = agent.name;
    const status = node.querySelector('.agent-status'); status.textContent = online ? 'ONLINE' : 'OFFLINE'; status.classList.toggle('offline', !online);
    node.querySelector('.status-dot').classList.toggle('online', online);
    node.querySelector('.agent-meta').textContent = [agent.platform, agent.agent_version].filter(Boolean).join(' · ') || 'LAN Agent';
    node.querySelector('.lan-ip').textContent = fmtIp(agent.lan_ip); node.querySelector('.public-ip').textContent = fmtIp(agent.public_ip); node.querySelector('.tailscale-ip').textContent = fmtIp(agent.tailscale_ip);
    node.querySelector('.latency').textContent = agent.last_latency_ms == null ? '—' : `${agent.last_latency_ms} ms`; node.querySelector('.last-seen').textContent = ago(agent.last_seen_at);
    node.querySelector('.rescan-btn').addEventListener('click', () => enqueueCommand(agent.id, 'rescan', {}));
    const rows = node.querySelector('.proxy-rows'); const agentProxies = proxies.filter(p => p.agent_id === agent.id); node.querySelector('.no-proxies').classList.toggle('hidden', agentProxies.length > 0);
    for (const proxy of agentProxies) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><code>${escapeHtml(proxy.host)}:${Number(proxy.port)}</code></td><td>${escapeHtml(proxy.protocol.toUpperCase())}</td><td><span class="health ${proxy.healthy ? 'ok' : ''}">${proxy.healthy ? 'healthy' : 'unhealthy'}</span></td><td>${proxy.latency_ms == null ? '—' : `${proxy.latency_ms} ms`}</td><td><button class="switch ${proxy.enabled ? 'on' : ''}" aria-label="toggle proxy"></button></td><td><button class="button ghost validate-btn">Validate</button></td>`;
      tr.querySelector('.switch').addEventListener('click', () => enqueueCommand(agent.id, 'set_proxy_enabled', { host: proxy.host, port: proxy.port, protocol: proxy.protocol, enabled: !proxy.enabled }));
      tr.querySelector('.validate-btn').addEventListener('click', () => enqueueCommand(agent.id, 'validate_proxy', { host: proxy.host, port: proxy.port, protocol: proxy.protocol }));
      rows.appendChild(tr);
    }
    els.agentsList.appendChild(node);
  }
}

async function enqueueCommand(agentId, commandType, payload) {
  if (!currentUser) return;
  const { error } = await sb.from('lan_agent_commands').insert({ agent_id: agentId, user_id: currentUser.id, command_type: commandType, payload });
  if (error) alert(`Command failed: ${error.message}`);
}

async function generatePairing() {
  els.generatePairingBtn.disabled = true; const { data, error } = await sb.rpc('lan_create_pairing_key'); els.generatePairingBtn.disabled = false;
  if (error || !data?.[0]) return alert(error?.message || 'Could not create pairing key.');
  const row = data[0]; els.pairingCode.textContent = row.pairing_key.replace(/(.{4})/g, '$1 ').trim(); els.pairingEmpty.classList.add('hidden'); els.pairingActive.classList.remove('hidden'); pairingExpiresAt = new Date(row.expires_at).getTime();
  if (pairingTimer) clearInterval(pairingTimer); pairingTimer = setInterval(updatePairingCountdown, 1000); updatePairingCountdown();
}
function updatePairingCountdown() { const left = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000)); const m = Math.floor(left / 60), s = left % 60; els.pairingCountdown.textContent = left ? `in ${m}:${String(s).padStart(2,'0')}` : 'expired'; if (!left) { clearInterval(pairingTimer); pairingTimer = null; els.pairingCode.textContent = 'EXPIRED'; } }

function startRealtime() {
  if (realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel(`lan-registry-${currentUser.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'lan_agents' }, loadRegistry).on('postgres_changes', { event: '*', schema: 'public', table: 'lan_proxies' }, loadRegistry).on('postgres_changes', { event: '*', schema: 'public', table: 'lan_agent_commands' }, loadRegistry).subscribe(status => { els.statRealtime.textContent = status === 'SUBSCRIBED' ? 'LIVE' : status; });
}

async function applySession(session) {
  currentUser = session?.user || null; els.authView.classList.toggle('hidden', !!currentUser); els.dashboardView.classList.toggle('hidden', !currentUser); els.signOutBtn.classList.toggle('hidden', !currentUser);
  if (currentUser) { startRealtime(); await loadRegistry(); } else { if (realtimeChannel) await sb.removeChannel(realtimeChannel); realtimeChannel = null; agents = []; proxies = []; els.connectionPill.textContent = 'SUPABASE · IDLE'; els.connectionPill.className = 'pill muted'; }
}

els.authForm.addEventListener('submit', async e => { e.preventDefault(); setAuthMessage('Signing in…'); const { data, error } = await sb.auth.signInWithPassword({ email: els.emailInput.value.trim(), password: els.passwordInput.value }); if (error) return setAuthMessage(error.message, true); setAuthMessage(''); await applySession(data.session); });
els.signUpBtn.addEventListener('click', async () => { setAuthMessage('Creating account…'); const { data, error } = await sb.auth.signUp({ email: els.emailInput.value.trim(), password: els.passwordInput.value }); if (error) return setAuthMessage(error.message, true); setAuthMessage(data.session ? 'Account created.' : 'Account created. Check your email if confirmation is enabled.'); if (data.session) await applySession(data.session); });
els.signOutBtn.addEventListener('click', async () => { await sb.auth.signOut(); await applySession(null); });
els.generatePairingBtn.addEventListener('click', generatePairing); els.refreshBtn.addEventListener('click', loadRegistry);
els.copyPairingBtn.addEventListener('click', async () => { const value = els.pairingCode.textContent.replaceAll(' ', ''); await navigator.clipboard.writeText(value); const old = els.copyPairingBtn.textContent; els.copyPairingBtn.textContent = 'Copied'; setTimeout(() => els.copyPairingBtn.textContent = old, 1200); });
sb.auth.onAuthStateChange((_event, session) => { applySession(session); });
(async () => { const { data } = await sb.auth.getSession(); await applySession(data.session); setInterval(renderRegistry, 3000); })();
