const SUPABASE_URL = 'https://zkrhwqgmynbbmoktokdq.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Fqcxk9-U1qalClQZjKcrhA_U822LTIq';

if (!window.supabase) {
  const pill = document.getElementById('connectionPill');
  if (pill) {
    pill.textContent = 'SUPABASE CLIENT · LOAD ERROR';
    pill.className = 'pill offline';
  }
  throw new Error('Supabase JS client failed to load');
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

const els = Object.fromEntries([
  'authView','dashboardView','authForm','emailInput','passwordInput','signUpBtn',
  'signOutBtn','authMessage','dashboardMessage','connectionPill','generatePairingBtn',
  'pairingEmpty','pairingActive','pairingCode','pairingCountdown','copyPairingBtn',
  'refreshBtn','agentsEmpty','agentsList','statAgents','statProxies','statHealthy',
  'statRealtime','agentTemplate'
].map(id => [id, document.getElementById(id)]));

let currentUser = null;
let agents = [];
let proxies = [];
let realtimeChannel = null;
let realtimeUserId = null;
let pairingTimer = null;
let pairingExpiresAt = null;
let registryLoadInFlight = false;
let registryReloadRequested = false;
let registryRefreshTimer = null;
let dashboardMessageTimer = null;

function setAuthMessage(message, error = false) {
  els.authMessage.textContent = message || '';
  els.authMessage.classList.toggle('error', error);
}

function setDashboardMessage(message, error = false, timeoutMs = 5000) {
  if (!els.dashboardMessage) return;
  els.dashboardMessage.textContent = message || '';
  els.dashboardMessage.classList.toggle('error', error);
  if (dashboardMessageTimer) clearTimeout(dashboardMessageTimer);
  if (message && timeoutMs > 0) {
    dashboardMessageTimer = setTimeout(() => {
      els.dashboardMessage.textContent = '';
      els.dashboardMessage.classList.remove('error');
    }, timeoutMs);
  }
}

function fmtIp(value) {
  return value || '—';
}

function isOnline(agent) {
  return !!agent.last_seen_at &&
    Date.now() - new Date(agent.last_seen_at).getTime() < 30000;
}

function ago(value) {
  if (!value) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    "'":'&#39;',
    '"':'&quot;'
  }[char]));
}

function refreshRelativeTimes() {
  for (const node of document.querySelectorAll('[data-last-seen]')) {
    node.textContent = ago(node.dataset.lastSeen);
  }
}

function scheduleRegistryRefresh() {
  if (registryRefreshTimer) return;
  registryRefreshTimer = setTimeout(() => {
    registryRefreshTimer = null;
    loadRegistry();
  }, 150);
}

async function loadRegistry() {
  if (!currentUser) return;
  if (registryLoadInFlight) {
    registryReloadRequested = true;
    return;
  }

  registryLoadInFlight = true;
  registryReloadRequested = false;

  try {
    const { data: agentData, error: agentError } = await sb
      .from('lan_agents')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (agentError) throw agentError;

    const nextAgents = agentData || [];
    const agentIds = nextAgents.map(agent => agent.id);
    let nextProxies = [];

    if (agentIds.length) {
      const { data: proxyData, error: proxyError } = await sb
        .from('lan_proxies')
        .select('*')
        .in('agent_id', agentIds)
        .order('created_at', { ascending: true });
      if (proxyError) throw proxyError;
      nextProxies = proxyData || [];
    }

    agents = nextAgents;
    proxies = nextProxies;
    els.connectionPill.textContent = 'SUPABASE · CONNECTED';
    els.connectionPill.className = 'pill';
    renderRegistry();
  } catch (error) {
    els.connectionPill.textContent = 'SUPABASE · ERROR';
    els.connectionPill.className = 'pill offline';
    setDashboardMessage(
      `Could not refresh registry: ${error?.message || String(error)}`,
      true
    );
    console.error(error);
  } finally {
    registryLoadInFlight = false;
    if (registryReloadRequested) {
      registryReloadRequested = false;
      scheduleRegistryRefresh();
    }
  }
}

function renderRegistry() {
  const onlineAgents = agents.filter(isOnline);
  const onlineIds = new Set(onlineAgents.map(agent => agent.id));

  els.statAgents.textContent = onlineAgents.length;
  els.statProxies.textContent = proxies.length;
  els.statHealthy.textContent = proxies.filter(
    proxy => proxy.healthy && proxy.enabled && onlineIds.has(proxy.agent_id)
  ).length;

  els.agentsEmpty.classList.toggle('hidden', agents.length > 0);
  els.agentsList.replaceChildren();

  for (const agent of agents) {
    const node = els.agentTemplate.content.cloneNode(true);
    const online = isOnline(agent);

    node.querySelector('.agent-name').textContent = agent.name;
    const status = node.querySelector('.agent-status');
    status.textContent = online ? 'ONLINE' : 'OFFLINE';
    status.classList.toggle('offline', !online);
    node.querySelector('.status-dot').classList.toggle('online', online);
    node.querySelector('.agent-meta').textContent =
      [agent.platform, agent.agent_version].filter(Boolean).join(' · ') || 'LAN Agent';

    node.querySelector('.lan-ip').textContent = fmtIp(agent.lan_ip);
    node.querySelector('.public-ip').textContent = fmtIp(agent.public_ip);
    node.querySelector('.tailscale-ip').textContent = fmtIp(agent.tailscale_ip);
    node.querySelector('.latency').textContent =
      agent.last_latency_ms == null ? '—' : `${agent.last_latency_ms} ms`;

    const lastSeen = node.querySelector('.last-seen');
    lastSeen.dataset.lastSeen = agent.last_seen_at || '';
    lastSeen.textContent = ago(agent.last_seen_at);

    const rescanButton = node.querySelector('.rescan-btn');
    rescanButton.disabled = !online;
    rescanButton.title = online ? 'Ask the agent to rescan the LAN' : 'Agent is offline';
    rescanButton.addEventListener('click', () =>
      enqueueCommand(agent, 'rescan', {}, rescanButton)
    );

    const renameButton = node.querySelector('.rename-agent-btn');
    renameButton.disabled = !online;
    renameButton.addEventListener('click', async () => {
      const value = window.prompt('New agent name', agent.name);
      if (value === null) return;
      const name = value.trim().slice(0, 80);
      if (!name) return setDashboardMessage('Agent name cannot be empty.', true);
      await enqueueCommand(agent, 'rename_agent', { name }, renameButton);
    });

    const removeButton = node.querySelector('.remove-agent-btn');
    removeButton.addEventListener('click', () => removeAgent(agent, removeButton));

    const rows = node.querySelector('.proxy-rows');
    const agentProxies = proxies.filter(proxy => proxy.agent_id === agent.id);
    node.querySelector('.no-proxies').classList.toggle('hidden', agentProxies.length > 0);

    for (const proxy of agentProxies) {
      const effectiveHealthy = online && proxy.healthy;
      const healthLabel = !online
        ? 'agent offline'
        : proxy.healthy
          ? 'healthy'
          : 'unhealthy';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${escapeHtml(proxy.host)}:${Number(proxy.port)}</code></td>
        <td>${escapeHtml(proxy.protocol.toUpperCase())}</td>
        <td><span class="health ${effectiveHealthy ? 'ok' : ''}" title="Last checked ${escapeHtml(ago(proxy.last_checked_at))}">${healthLabel}</span></td>
        <td>${proxy.latency_ms == null ? '—' : `${proxy.latency_ms} ms`}</td>
        <td><button class="switch ${proxy.enabled ? 'on' : ''}" aria-label="toggle registry state"></button></td>
        <td><button class="button ghost validate-btn">Validate</button></td>`;

      const toggleButton = tr.querySelector('.switch');
      const validateButton = tr.querySelector('.validate-btn');
      toggleButton.disabled = !online;
      validateButton.disabled = !online;

      toggleButton.addEventListener('click', () =>
        enqueueCommand(
          agent,
          'set_proxy_enabled',
          {
            host: proxy.host,
            port: proxy.port,
            protocol: proxy.protocol,
            enabled: !proxy.enabled
          },
          toggleButton
        )
      );

      validateButton.addEventListener('click', () =>
        enqueueCommand(
          agent,
          'validate_proxy',
          {
            host: proxy.host,
            port: proxy.port,
            protocol: proxy.protocol
          },
          validateButton
        )
      );

      rows.appendChild(tr);
    }

    els.agentsList.appendChild(node);
  }

  refreshRelativeTimes();
}

async function enqueueCommand(agent, commandType, payload, button = null) {
  if (!currentUser) return;

  if (!isOnline(agent)) {
    return setDashboardMessage(
      `${agent.name} is offline. Wait for it to reconnect before sending a command.`,
      true
    );
  }

  if (button) button.disabled = true;

  try {
    if (commandType === 'rescan') {
      const { data: pending, error: pendingError } = await sb
        .from('lan_agent_commands')
        .select('id')
        .eq('agent_id', agent.id)
        .eq('user_id', currentUser.id)
        .eq('command_type', 'rescan')
        .in('status', ['queued', 'acknowledged'])
        .limit(1);

      if (pendingError) throw pendingError;
      if (pending?.length) {
        setDashboardMessage(`A rescan is already pending for ${agent.name}.`);
        return;
      }
    }

    const { error } = await sb.from('lan_agent_commands').insert({
      agent_id: agent.id,
      user_id: currentUser.id,
      command_type: commandType,
      payload
    });

    if (error) throw error;
    setDashboardMessage(
      `Command queued for ${agent.name}. It will run on the next heartbeat.`
    );
  } catch (error) {
    setDashboardMessage(
      `Command failed: ${error?.message || String(error)}`,
      true
    );
  } finally {
    if (button) button.disabled = false;
  }
}

async function removeAgent(agent, button) {
  const confirmed = window.confirm(
    `Remove ${agent.name}? This revokes its credential and deletes its registered proxies and queued commands.`
  );
  if (!confirmed) return;

  button.disabled = true;
  try {
    const { error } = await sb
      .from('lan_agents')
      .delete()
      .eq('id', agent.id)
      .eq('user_id', currentUser.id);
    if (error) throw error;
    setDashboardMessage(
      `${agent.name} was removed. Its local agent must be paired again before it can reconnect.`
    );
    await loadRegistry();
  } catch (error) {
    setDashboardMessage(
      `Could not remove agent: ${error?.message || String(error)}`,
      true
    );
  } finally {
    button.disabled = false;
  }
}

async function generatePairing() {
  els.generatePairingBtn.disabled = true;
  try {
    const { data, error } = await sb.rpc('lan_create_pairing_key');
    if (error || !data?.[0]) {
      throw error || new Error('Could not create pairing key.');
    }

    const row = data[0];
    els.pairingCode.textContent =
      row.pairing_key.replace(/(.{4})/g, '$1 ').trim();
    els.pairingEmpty.classList.add('hidden');
    els.pairingActive.classList.remove('hidden');
    pairingExpiresAt = new Date(row.expires_at).getTime();

    if (pairingTimer) clearInterval(pairingTimer);
    pairingTimer = setInterval(updatePairingCountdown, 1000);
    updatePairingCountdown();
  } catch (error) {
    setDashboardMessage(
      `Could not generate pairing key: ${error?.message || String(error)}`,
      true
    );
  } finally {
    els.generatePairingBtn.disabled = false;
  }
}

function updatePairingCountdown() {
  const left = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000));
  const minutes = Math.floor(left / 60);
  const seconds = left % 60;
  els.pairingCountdown.textContent =
    left ? `in ${minutes}:${String(seconds).padStart(2, '0')}` : 'expired';

  if (!left) {
    clearInterval(pairingTimer);
    pairingTimer = null;
    els.pairingCode.textContent = 'EXPIRED';
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the legacy copy path.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.className = 'clipboard-helper';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Clipboard access is unavailable');
}

async function startRealtime() {
  if (!currentUser) return;
  if (realtimeChannel && realtimeUserId === currentUser.id) return;

  if (realtimeChannel) {
    await sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
    realtimeUserId = null;
  }

  realtimeUserId = currentUser.id;
  realtimeChannel = sb
    .channel(`lan-registry-${currentUser.id}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lan_agents' },
      scheduleRegistryRefresh
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lan_proxies' },
      scheduleRegistryRefresh
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'lan_agent_commands' },
      scheduleRegistryRefresh
    )
    .subscribe(status => {
      els.statRealtime.textContent = status === 'SUBSCRIBED' ? 'LIVE' : status;
      if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) {
        setDashboardMessage(
          'Realtime connection is degraded. Manual refresh still works.',
          true,
          0
        );
      }
    });
}

async function applySession(session) {
  const previousUserId = currentUser?.id || null;
  currentUser = session?.user || null;
  const nextUserId = currentUser?.id || null;

  els.authView.classList.toggle('hidden', !!currentUser);
  els.dashboardView.classList.toggle('hidden', !currentUser);
  els.signOutBtn.classList.toggle('hidden', !currentUser);

  if (currentUser) {
    await startRealtime();
    if (previousUserId !== nextUserId || !agents.length) {
      await loadRegistry();
    }
  } else {
    if (realtimeChannel) await sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
    realtimeUserId = null;
    agents = [];
    proxies = [];
    els.agentsList.replaceChildren();
    els.connectionPill.textContent = 'SUPABASE · IDLE';
    els.connectionPill.className = 'pill muted';
    els.statRealtime.textContent = '—';
    if (pairingTimer) clearInterval(pairingTimer);
    pairingTimer = null;
    pairingExpiresAt = null;
    els.pairingActive.classList.add('hidden');
    els.pairingEmpty.classList.remove('hidden');
    els.pairingCode.textContent = '———— ———— ————';
    setDashboardMessage('');
  }
}

els.authForm.addEventListener('submit', async event => {
  event.preventDefault();
  setAuthMessage('Signing in…');
  const { data, error } = await sb.auth.signInWithPassword({
    email: els.emailInput.value.trim(),
    password: els.passwordInput.value
  });
  if (error) return setAuthMessage(error.message, true);
  setAuthMessage('');
  await applySession(data.session);
});

els.signUpBtn.addEventListener('click', async () => {
  setAuthMessage('Creating account…');
  const { data, error } = await sb.auth.signUp({
    email: els.emailInput.value.trim(),
    password: els.passwordInput.value
  });
  if (error) return setAuthMessage(error.message, true);
  setAuthMessage(
    data.session
      ? 'Account created.'
      : 'Account created. Check your email if confirmation is enabled.'
  );
  if (data.session) await applySession(data.session);
});

els.signOutBtn.addEventListener('click', async () => {
  await sb.auth.signOut();
  await applySession(null);
});

els.generatePairingBtn.addEventListener('click', generatePairing);
els.refreshBtn.addEventListener('click', loadRegistry);

els.copyPairingBtn.addEventListener('click', async () => {
  const value = els.pairingCode.textContent.replaceAll(' ', '');
  if (!value || value === 'EXPIRED') return;
  try {
    await copyText(value);
    const old = els.copyPairingBtn.textContent;
    els.copyPairingBtn.textContent = 'Copied';
    setTimeout(() => { els.copyPairingBtn.textContent = old; }, 1200);
  } catch (error) {
    setDashboardMessage(
      `Could not copy pairing key: ${error?.message || String(error)}`,
      true
    );
  }
});

sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => applySession(session), 0);
});

window.addEventListener('unhandledrejection', event => {
  console.error(event.reason);
  setDashboardMessage(
    `Unexpected client error: ${event.reason?.message || String(event.reason)}`,
    true
  );
});

(async () => {
  const { data, error } = await sb.auth.getSession();
  if (error) setAuthMessage(error.message, true);
  await applySession(data?.session || null);
  setInterval(refreshRelativeTimes, 1000);
})();
