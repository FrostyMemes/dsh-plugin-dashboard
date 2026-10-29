import { useEffect, useMemo, useRef, useState } from 'react';
import { orderAgents } from './agent-order.mjs';

const API = '/dsh-agent-control-center/api';
type MetricValue = number | null | undefined;
type TokenValues = { input: MetricValue; output: MetricValue; cacheRead: MetricValue; cacheWrite: MetricValue } | null;
type Agent = {
  id: string;
  parentId: string | null;
  name: string;
  title: string | null;
  status: 'idle' | 'running' | 'unknown';
  task: string;
  model: string | null;
  runningOrder: number | null;
  metrics: {
    context: { used: MetricValue; capacity: MetricValue; estimated: boolean };
    tokens: TokenValues;
    children: { direct: MetricValue; total: MetricValue };
    durationMs: MetricValue;
  };
  sourceDiagnostics: string[];
};
type Snapshot = {
  bootId: string;
  revision: number;
  generatedAt: string;
  completeness: string;
  agents: Agent[];
};
type UpdateEvent = Pick<Snapshot, 'bootId' | 'revision' | 'generatedAt'> & { agent: Agent };
type RemoveEvent = Pick<Snapshot, 'bootId' | 'revision' | 'generatedAt'> & { removedId: string };

const tokenKeys: Array<keyof NonNullable<TokenValues>> = ['input', 'output', 'cacheRead', 'cacheWrite'];
const tokenGroups: Array<[string, keyof NonNullable<TokenValues>, string]> = [
  ['Input', 'input', 'bar-input'],
  ['Output', 'output', 'bar-output'],
  ['Cache read', 'cacheRead', 'bar-cache'],
  ['Cache write', 'cacheWrite', 'bar-cache'],
];

function formatNumber(value: MetricValue) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat().format(value)
    : 'Unavailable';
}

function formatDuration(value: MetricValue) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value < 60_000) return `${Math.floor(value / 1000)}s`;
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor((value % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTime(value: Date | null) {
  if (!value) return 'No update received';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleTimeString();
}

function completenessText(value: Snapshot['completeness'] | undefined) {
  if (!value) return 'Completeness unavailable';
  return value.replace(/_/g, ' ');
}

function shortSessionId(id: string) {
  return id.length > 19 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id;
}

function displayName(agent: Agent) {
  if (agent.title?.trim()) return agent.title;
  if (agent.name && agent.name !== agent.id) return agent.name;
  return shortSessionId(agent.id);
}

function StatusPill({ status }: { status?: string | null }) {
  const normalized = typeof status === 'string' ? status.toLowerCase() : 'unknown';
  const known = ['running', 'idle', 'not_loaded', 'unknown', 'disconnected'].includes(normalized);
  return <span className={`status-pill status-${known ? normalized : 'unknown'}`}><i />{known ? normalized.replace('_', ' ') : 'Status unavailable'}</span>;
}

function MetricBar({ label, used, capacity, estimated }: { label: string; used?: MetricValue; capacity?: MetricValue; estimated?: boolean | null }) {
  const valid = typeof used === 'number' && Number.isFinite(used)
    && typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0;
  const actualPercentage = valid ? used / capacity * 100 : 0;
  const barWidth = Math.min(100, Math.max(0, actualPercentage));
  return (
    <div className="context-metric">
      <div className="metric-heading">
        <span>{label}</span>
        {valid ? <span>{formatNumber(used)} / {formatNumber(capacity)} tokens{estimated ? ' · estimated' : ''}</span> : <span>Unavailable</span>}
      </div>
      <div className="metric-track" role="img" aria-label={valid ? `${label}: ${actualPercentage.toFixed(0)} percent${estimated ? ', estimated' : ''}` : `${label} unavailable`}>
        {valid && <span className="metric-fill bar-context" style={{ width: `${barWidth}%` }} />}
      </div>
      {valid && <div className="metric-foot"><span>{actualPercentage.toFixed(0)}%</span><span>{estimated ? 'Estimated value' : 'Reported value'}</span></div>}
    </div>
  );
}

function TokenMetrics({ tokens }: { tokens?: TokenValues }) {
  return (
    <div className="token-metrics">
      {tokenGroups.map(([label, key, color]) => {
        const value = tokens?.[key];
        const available = typeof value === 'number' && Number.isFinite(value);
        return <div className="token-item" key={key}>
          <span className={`token-dot ${color}`} />
          <span className="token-label">{label}</span>
          <strong>{available ? formatNumber(value) : 'Unavailable'}</strong>
        </div>;
      })}
    </div>
  );
}

function AgentCard({ agent, onDetails }: { agent: Agent; onDetails: () => void }) {
  const metrics = agent.metrics || {};
  const identity = displayName(agent) || 'Unnamed agent';
  const kind = agent.parentId ? 'Subagent' : 'Root agent';
  return (
    <article className="agent-card">
      <div className="card-topline"><span className="agent-kind">{kind}</span><StatusPill status={agent.status} /></div>
      <div className="agent-title-row">
        <div className="min-width-zero"><h2 title={identity}>{identity}</h2><p className="agent-id" title={agent.id || ''}>{agent.id || 'ID unavailable'}</p></div>
        <button className="icon-button" title="Copy agent ID" aria-label="Copy agent ID" onClick={() => { void navigator.clipboard?.writeText(agent.id); }}>⧉</button>
      </div>
      <div className="identity-meta"><span>Last active model</span><strong>{agent.model || 'Unavailable'}</strong></div>
      <div className="task-box"><span className="eyebrow">Current task</span><p>{agent.task || 'Task unavailable'}</p></div>
      <MetricBar label="Context" used={metrics.context?.used} capacity={metrics.context?.capacity} estimated={metrics.context?.estimated} />
      <TokenMetrics tokens={metrics.tokens} />
      <div className="card-stats">
        <div><span>Known direct children</span><strong>{formatNumber(metrics.children.direct)}</strong></div>
        <div><span>Duration</span><strong>{formatDuration(metrics.durationMs)}</strong></div>
      </div>
      <div className="card-bottom"><span>Observation may be incomplete</span><button className="text-button" onClick={onDetails}>Details <span aria-hidden="true">→</span></button></div>
    </article>
  );
}

function Diagnostics({ diagnostics }: { diagnostics?: Agent['sourceDiagnostics'] }) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return <p className="muted-copy">No source diagnostics reported.</p>;
  return <ul className="diagnostic-list">{diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul>;
}

function DetailsPanel({ agent, agents, onClose }: { agent: Agent | null; agents: Agent[]; onClose: () => void }) {
  if (!agent) return null;
  const children = agents.filter(item => item.parentId === agent.id);
  return <div className="scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="details-panel" aria-label="Agent details">
      <div className="panel-heading"><div><span className="eyebrow">Agent details</span><h2>{displayName(agent) || 'Unnamed agent'}</h2></div><button className="icon-button close-button" aria-label="Close details" onClick={onClose}>×</button></div>
      <StatusPill status={agent.status} />
      <section className="detail-section"><h3>Overview</h3><dl><dt>Session title</dt><dd>{agent.title || 'Unavailable'}</dd><dt>ID</dt><dd>{agent.id || 'Unavailable'}</dd><dt>Parent ID</dt><dd>{agent.parentId || 'None reported'}</dd><dt>Type</dt><dd>{agent.parentId ? 'Subagent' : 'Root agent'}</dd><dt>Last active model</dt><dd>{agent.model || 'Unavailable'}</dd><dt>Current task</dt><dd>{agent.task || 'Unavailable'}</dd><dt>Duration</dt><dd>{formatDuration(agent.metrics?.durationMs)}</dd></dl></section>
      <section className="detail-section"><h3>Context &amp; tokens</h3><MetricBar label="Context" used={agent.metrics?.context?.used} capacity={agent.metrics?.context?.capacity} estimated={agent.metrics?.context?.estimated} /><TokenMetrics tokens={agent.metrics?.tokens} /></section>
      <section className="detail-section"><h3>Observed direct children <span className="section-count">{children.length}</span></h3>{children.length ? <ul className="child-list">{children.map(child => <li key={child.id}><span>{displayName(child) || 'Unnamed agent'}</span><StatusPill status={child.status} /></li>)}</ul> : <p className="muted-copy">No direct children are present in this snapshot.</p>}</section>
      <section className="detail-section"><h3>Source diagnostics</h3><Diagnostics diagnostics={agent.sourceDiagnostics} /></section>
    </aside>
  </div>;
}

function TreeView({ agents, observed, onSelect }: { agents: Agent[]; observed: boolean; onSelect: (agent: Agent) => void }) {
  const byParent = useMemo(() => {
    const map = new Map<string | null | undefined, Agent[]>();
    agents.forEach(agent => {
      const key = agent.parentId || null;
      map.set(key, [...(map.get(key) || []), agent]);
    });
    return map;
  }, [agents]);
  const renderNode = (agent: Agent, seen: Set<string | null | undefined> = new Set()) => {
    if (seen.has(agent.id)) return null;
    const nextSeen = new Set(seen).add(agent.id);
    return <li key={agent.id || agent.name}>
      <button className="tree-node" onClick={() => onSelect(agent)}><span className="tree-name">{displayName(agent) || 'Unnamed agent'}</span><span className="tree-id">{agent.id || 'ID unavailable'}</span><StatusPill status={agent.status} /></button>
      {(byParent.get(agent.id) || []).length > 0 && <ul>{(byParent.get(agent.id) || []).map(child => renderNode(child, nextSeen))}</ul>}
    </li>;
  };
  const roots = byParent.get(null) || [];
  const knownIds = new Set(agents.map(agent => agent.id));
  const orphaned = agents.filter(agent => agent.parentId && !knownIds.has(agent.parentId));
  if (!agents.length) return <div className="empty-state"><strong>{observed ? 'No agents observed' : 'Snapshot unavailable'}</strong><span>{observed ? 'The current snapshot does not include agent records.' : 'Pair with the Desktop instance to load its agent snapshot.'}</span></div>;
  return <div className="tree-view"><p className="tree-note">Only reported parent relationships are shown. Missing branches are not inferred.</p><ul className="tree-root">{roots.map(agent => renderNode(agent))}{orphaned.length > 0 && <li className="orphan-group"><span className="orphan-label">Parent not present in snapshot</span><ul>{orphaned.map(agent => renderNode(agent))}</ul></li>}</ul></div>;
}

function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<'connected' | 'stale' | 'reconnecting' | 'disconnected'>('disconnected');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [view, setView] = useState<'dashboard' | 'tree'>('dashboard');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [token, setToken] = useState('');
  const [pairError, setPairError] = useState('');
  const [paired, setPaired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const lastSseMessageRef = useRef(0);

  const acceptSnapshot = (data: Snapshot) => {
    if (!data || !Array.isArray(data.agents)) return;
    snapshotRef.current = data;
    setSnapshot(data);
    setAgents(data.agents);
    setUpdatedAt(new Date());
    setPaired(true);
    setLoading(false);
  };

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = hash.get('token');
    if (fragmentToken) {
      setToken(fragmentToken);
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }

    let cancelled = false;
    fetch(`${API}/snapshot`, { credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 401 ? 'Pair with this dashboard to view the snapshot.' : `Snapshot unavailable (${response.status}).`);
        return response.json();
      })
      .then(data => { if (!cancelled) acceptSnapshot(data); })
      .catch(error => { if (!cancelled) setPairError(error.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; sourceRef.current?.close(); };
  }, []);

  useEffect(() => {
    if (!paired) return undefined;
    const source = new EventSource(`${API}/events`, { withCredentials: true });
    sourceRef.current = source;
    lastSseMessageRef.current = Date.now();
    let restartTimer: number | undefined;
    const markLive = () => {
      lastSseMessageRef.current = Date.now();
      setConnection('connected');
    };
    source.onopen = markLive;
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting');
    source.addEventListener('heartbeat', markLive);
    source.addEventListener('snapshot', event => {
      try { acceptSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot); markLive(); } catch { setConnection('reconnecting'); }
    });
    source.addEventListener('update', event => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as UpdateEvent;
        const previous = snapshotRef.current;
        if (!previous || update.bootId !== previous.bootId || !update.agent) return;
        if (update.revision <= previous.revision) return;
        const found = previous.agents.some(agent => agent.id === update.agent.id);
        const nextAgents = found ? previous.agents.map(agent => agent.id === update.agent.id ? update.agent : agent) : [...previous.agents, update.agent];
        acceptSnapshot({ ...previous, revision: update.revision, generatedAt: update.generatedAt, agents: nextAgents });
        markLive();
      } catch { setConnection('reconnecting'); }
    });
    source.addEventListener('remove', event => {
      try {
        const removal = JSON.parse((event as MessageEvent<string>).data) as RemoveEvent;
        const previous = snapshotRef.current;
        if (!previous || removal.bootId !== previous.bootId || removal.revision <= previous.revision) return;
        acceptSnapshot({ ...previous, revision: removal.revision, generatedAt: removal.generatedAt, agents: previous.agents.filter(agent => agent.id !== removal.removedId) });
        markLive();
      } catch { setConnection('reconnecting'); }
    });
    const freshnessTimer = setInterval(() => {
      if (source.readyState === EventSource.OPEN && Date.now() - lastSseMessageRef.current > 45_000) {
        setConnection('stale');
        source.close();
        restartTimer = window.setTimeout(() => setStreamEpoch(epoch => epoch + 1), 5_000);
      }
    }, 5_000);
    return () => { clearInterval(freshnessTimer); if (restartTimer !== undefined) clearTimeout(restartTimer); source.close(); if (sourceRef.current === source) sourceRef.current = null; };
  }, [paired, streamEpoch]);

  async function pair(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPairError('');
    try {
      const response = await fetch(`${API}/pair`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'Pairing token was not accepted.' : `Pairing failed (${response.status}).`);
      setToken('');
      const snapshotResponse = await fetch(`${API}/snapshot`, { credentials: 'same-origin' });
      if (!snapshotResponse.ok) throw new Error(`Paired, but snapshot is unavailable (${snapshotResponse.status}).`);
      acceptSnapshot(await snapshotResponse.json());
    } catch (error) { setPairError(error instanceof Error ? error.message : 'Pairing failed.'); }
  }

  const filtered = useMemo(() => orderAgents(agents.filter(agent => {
    const haystack = `${agent.title || ''} ${agent.name || ''} ${agent.id || ''} ${agent.task || ''} ${agent.model || ''}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase()))
      && (statusFilter === 'all' || agent.status === statusFilter)
      && (typeFilter === 'all' || (typeFilter === 'root' ? !agent.parentId : Boolean(agent.parentId)));
  })), [agents, query, statusFilter, typeFilter]);

  const totalTokens = agents.reduce((sum, agent) => {
    const tokens = agent.metrics?.tokens;
    return sum + tokenKeys.reduce((total, key) => total + (typeof tokens?.[key] === 'number' && Number.isFinite(tokens[key]) ? tokens[key] : 0), 0);
  }, 0);
  const knownTokenMetricCount = agents.reduce((count, agent) => count + tokenKeys.filter(key => typeof agent.metrics?.tokens?.[key] === 'number').length, 0);
  const liveCount = agents.filter(agent => ['running', 'idle'].includes(agent.status)).length;
  const runningCount = agents.filter(agent => agent.status === 'running').length;
  const idleCount = agents.filter(agent => agent.status === 'idle').length;
  const subagents = agents.filter(agent => Boolean(agent.parentId)).length;
  const selected = selectedId ? agents.find(agent => agent.id === selectedId) ?? null : null;

  return <div className="app-shell">
    <header className="topbar"><div className="brand-mark" aria-hidden="true">D</div><div className="brand"><strong>DSH Agent Control Center</strong><span>Read-only runtime overview</span></div><div className={`connection connection-${connection}`}><span className="connection-dot" />{connection[0].toUpperCase() + connection.slice(1)}</div></header>
    <main className="main-content">
      <section className="page-heading"><div><p className="eyebrow">Desktop observer</p><h1>Agent dashboard</h1><p className="subtitle">One connected Harness Desktop instance · observation may be incomplete</p></div><div className="updated"><span>Last data update</span><strong>{formatTime(updatedAt)}</strong></div></section>

      {pairError && !paired && <section className="pair-card"><div><h2>Connect to this dashboard</h2><p>{pairError}</p></div><form onSubmit={pair}><label htmlFor="pair-token">Pairing token</label><div className="pair-input-row"><input id="pair-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="Paste pairing token" /><button className="primary-button" disabled={!token.trim()}>Connect</button></div></form></section>}

      <section className="summary-grid" aria-label="Agent summary">
        <SummaryCard label="Live agents" value={snapshot ? formatNumber(liveCount) : 'Unavailable'} note="Running or idle" icon="◉" />
        <SummaryCard label="Running" value={snapshot ? formatNumber(runningCount) : 'Unavailable'} note="Current status" icon="▶" />
        <SummaryCard label="Idle" value={snapshot ? formatNumber(idleCount) : 'Unavailable'} note="Current status" icon="Ⅱ" />
        <SummaryCard label="Known subagents" value={snapshot ? formatNumber(subagents) : 'Unavailable'} note="Present in snapshot" icon="⌘" />
        <SummaryCard label="Tokens available" value={knownTokenMetricCount ? formatNumber(totalTokens) : 'Unavailable'} note={knownTokenMetricCount ? `Sum of ${knownTokenMetricCount} reported counters` : 'No token counters reported'} icon="∑" />
      </section>

      <div className="observation-banner"><span className="banner-icon">i</span><span><strong>{completenessText(snapshot?.completeness)}</strong><small>Reported data only. Missing values are shown as unavailable.</small></span><span className="revision">Revision {typeof snapshot?.revision === 'number' ? formatNumber(snapshot.revision) : 'unavailable'}</span></div>

      <nav className="view-tabs" aria-label="Views"><button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button><button className={view === 'tree' ? 'active' : ''} onClick={() => setView('tree')}>Agent tree</button></nav>

        {view === 'dashboard' && <>
        <section className="controls"><div className="search-wrap"><span aria-hidden="true">⌕</span><input aria-label="Search agents" placeholder="Search name, task, model or ID" value={query} onChange={event => setQuery(event.target.value)} /></div><label className="filter-field"><span>Status</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="running">Running</option><option value="idle">Idle</option><option value="not_loaded">Not loaded</option><option value="unknown">Unknown</option><option value="disconnected">Disconnected</option></select></label><label className="filter-field"><span>Type</span><select value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option value="all">All types</option><option value="root">Root agents</option><option value="subagent">Subagents</option></select></label><div className="result-count">{formatNumber(filtered.length)} agents</div></section>
        {loading ? <div className="empty-state"><span className="loading-mark" /><strong>Loading snapshot…</strong><span>Waiting for the dashboard service.</span></div> : filtered.length ? <section className="agent-grid" aria-label="Agents">{filtered.map(agent => <AgentCard key={agent.id} agent={agent} onDetails={() => setSelectedId(agent.id)} />)}</section> : <div className="empty-state"><strong>{!snapshot ? 'Snapshot unavailable' : agents.length ? 'No matching agents' : 'No agents observed'}</strong><span>{!snapshot ? 'Pair with the Desktop instance to load its agent snapshot.' : agents.length ? 'Try another search or filter.' : 'No agent records were included in the current snapshot.'}</span></div>}
      </>}

      {view === 'tree' && <TreeView agents={agents} observed={snapshot !== null} onSelect={agent => setSelectedId(agent.id)} />}
      <footer className="page-footer">This view does not control agents or change task execution.</footer>
    </main>
    <DetailsPanel agent={selected} agents={agents} onClose={() => setSelectedId(null)} />
  </div>;
}

function SummaryCard({ label, value, note, icon }: { label: string; value: string; note: string; icon: string }) {
  return <article className="summary-card"><div className="summary-icon" aria-hidden="true">{icon}</div><div className="summary-copy"><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>;
}

export default App;
