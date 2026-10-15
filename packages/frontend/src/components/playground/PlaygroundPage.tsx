// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Playground Page
// Two modes:
//   "Test Ticket" — runs all 3 stages sequentially for a ticket,
//     shows per-stage result cards and a live web preview.
//   "Single Stage" — original isolated stage runner.
// ═══════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  usePlaygroundStore,
  usePlaygroundRun,
} from '../../store/playground';
import { useSettingsStore } from '../../store/settings';
import { useNavigationStore } from '../../store/navigation';
import { useToast } from '../../contexts/ToastContext';
import { getPlaygroundRuns, getLocalServerStatus, startLocalServer, stopLocalServer, getLocalServerEnv, saveLocalServerEnv, type LocalServerStatus } from '../../lib/api';
import { STAGE_INFO, type StageName } from '../../types';
import type { PlaygroundRunRecord } from '../../lib/api';

export const PLAYGROUND_ALLOWED_STAGES: readonly StageName[] = ['fetch_ticket', 'explore_plan', 'generate_code'];

// ── Elapsed-time hook ────────────────────────────────────────

function useElapsed(startedAt: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return '';
  const ms = Date.now() - startedAt;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Styles ───────────────────────────────────────────────────

const styles = {
  container: { display: 'flex', flexDirection: 'column' as const, gap: 'var(--sp-4)' },
  banner: {
    display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
    padding: 'var(--sp-3) var(--sp-4)', borderRadius: 'var(--radius-md)',
    background: 'var(--warning-muted)', color: 'var(--warning)', fontSize: 13, fontWeight: 600,
  },
  modeToggle: {
    display: 'inline-flex', borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-default)', overflow: 'hidden' as const, alignSelf: 'flex-start' as const,
  },
  modeBtn: {
    padding: 'var(--sp-2) var(--sp-4)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: 'none', background: 'transparent', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)',
  },
  modeBtnActive: { background: 'var(--accent-muted)', color: 'var(--accent)' },
  panel: {
    borderRadius: 'var(--radius-lg)', border: '1px solid var(--glass-border)',
    background: 'var(--glass-bg)', backdropFilter: 'blur(var(--glass-blur))',
    WebkitBackdropFilter: 'blur(var(--glass-blur))', padding: 'var(--sp-5)',
  },
  title: { fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 'var(--sp-4)' },
  // Ticket input bar
  ticketBar: { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' },
  ticketInput: {
    flex: 1, maxWidth: 200, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
    fontSize: 13, padding: 'var(--sp-2) var(--sp-3)', outline: 'none',
  },
  runBtn: {
    padding: 'var(--sp-2) var(--sp-5)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', border: 'none', background: 'linear-gradient(135deg, var(--accent), var(--blue))',
    color: '#fff', fontFamily: 'var(--font-sans)', display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)',
  },
  stopBtn: {
    padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', border: '1px solid var(--danger)', background: 'var(--danger-muted)',
    color: 'var(--danger)', fontFamily: 'var(--font-sans)',
  },
  resetBtn: {
    padding: 'var(--sp-2) var(--sp-3)', borderRadius: 'var(--radius-sm)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', border: '1px solid var(--border-default)', background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)',
  },
  // Pipeline stepper
  stepper: { display: 'flex', alignItems: 'center', gap: 0, marginBottom: 'var(--sp-4)' },
  stepItem: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 4, flex: 1 },
  stepConnector: { height: 2, flex: 1, background: 'var(--border-subtle)', marginTop: -10 },
  stepDot: { width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 },
  stepLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'center' as const },
  stepTime: { fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
  // Stage card
  stageCard: {
    borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)',
    background: 'var(--bg-surface)', overflow: 'hidden' as const, marginBottom: 'var(--sp-3)',
  },
  stageCardHeader: {
    display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
    padding: 'var(--sp-3) var(--sp-4)', cursor: 'pointer',
  },
  stageCardNum: {
    width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0,
  },
  stageCardLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1 },
  stageCardTime: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
  logsToggle: {
    padding: '2px 8px', borderRadius: 'var(--radius-sm)', fontSize: 10, fontWeight: 600,
    cursor: 'pointer', border: '1px solid var(--border-default)', background: 'transparent',
    color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)',
  },
  stageSummary: {
    padding: 'var(--sp-2) var(--sp-4) var(--sp-3)',
    fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
    borderTop: '1px solid var(--border-subtle)', fontStyle: 'italic' as const,
  },
  stagePending: {
    padding: 'var(--sp-3) var(--sp-4)',
    fontSize: 12, color: 'var(--text-ghost)', fontStyle: 'italic' as const,
    borderTop: '1px solid var(--border-subtle)',
  },
  // Terminal
  terminal: {
    background: '#0a0c10', height: 220, overflow: 'auto', fontFamily: 'var(--font-mono)',
    fontSize: 12, lineHeight: '20px', padding: 'var(--sp-2) 0',
  },
  logLine: { padding: '0 var(--sp-3)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const },
  emptyState: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', color: 'var(--text-ghost)', fontSize: 12, fontStyle: 'italic' as const,
  },
  // Single stage (existing)
  field: { marginBottom: 'var(--sp-4)' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 'var(--sp-2)' },
  stagePicker: { display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' as const },
  stageBtn: {
    padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', border: '1.5px solid var(--border-default)', background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)', transition: 'all 0.15s', fontFamily: 'var(--font-sans)',
  },
  stageBtnActive: { border: '1.5px solid var(--accent)', background: 'var(--accent-muted)', color: 'var(--accent)' },
  input: {
    width: '100%', maxWidth: 320, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
    fontSize: 12, padding: 'var(--sp-2) var(--sp-3)', outline: 'none',
  },
  textarea: {
    width: '100%', height: 100, background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-md)', padding: 'var(--sp-3)', color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' as const, outline: 'none',
  },
  hint: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 'var(--sp-1)' },
  lockedTicket: {
    width: '100%', maxWidth: 320, border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
    fontSize: 12, padding: 'var(--sp-2) var(--sp-3)',
  },
  openFullBtn: {
    padding: '4px 10px', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', border: '1px solid var(--border-default)', background: 'transparent',
    color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap' as const,
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' },
  statusBadge: {
    fontSize: 11, padding: '3px 10px', borderRadius: 10, fontWeight: 600,
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  },
  // History
  historyItem: {
    display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-2) var(--sp-3)',
    borderRadius: 'var(--radius-sm)', cursor: 'pointer', border: 'none', background: 'transparent',
    width: '100%', textAlign: 'left' as const, fontFamily: 'var(--font-sans)',
  },
  historyDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  historyLabel: { flex: 1, fontSize: 12, color: 'var(--text-secondary)' },
  historyTime: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
  // Web preview
  previewBar: { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' },
  previewUrl: { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', flex: 1 },
  previewBtnRow: { display: 'flex', gap: 'var(--sp-2)' },
  previewBtn: {
    padding: '4px 12px', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', border: '1px solid var(--border-default)', background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)',
  },
  openBtn: {
    padding: '4px 12px', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', border: '1px solid var(--accent)', background: 'var(--accent-muted)',
    color: 'var(--accent)', fontFamily: 'var(--font-sans)', textDecoration: 'none' as const,
    display: 'inline-flex', alignItems: 'center', gap: 4,
  },
  iframeWrap: {
    width: '100%', height: 480, borderRadius: 'var(--radius-md)', overflow: 'hidden' as const,
    border: '1px solid var(--border-subtle)', background: '#fff', position: 'relative' as const,
  },
  iframe: { width: '100%', height: '100%', border: 'none', display: 'block' },
  previewOffline: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: 'var(--sp-3)', color: 'var(--text-tertiary)', fontSize: 13, background: 'var(--bg-elevated)',
  },
  liveDot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  envSection: {
    marginBottom: 'var(--sp-3)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden' as const,
  },
  envHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: 'var(--sp-2) var(--sp-3)', cursor: 'pointer', userSelect: 'none' as const,
    background: 'var(--bg-elevated)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
  },
  envTextarea: {
    width: '100%', minHeight: 160, maxHeight: 320,
    padding: 'var(--sp-3)', fontFamily: 'var(--font-mono)', fontSize: 11,
    background: '#0a0c10', color: '#a8ff78', border: 'none', outline: 'none',
    resize: 'vertical' as const, lineHeight: 1.6, boxSizing: 'border-box' as const,
  },
  envFooter: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-elevated)',
    borderTop: '1px solid var(--border-default)',
  },
  envSaved: { fontSize: 11, color: 'var(--success)' },
  spinner: {
    width: 14, height: 14, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff',
    borderRadius: '50%', animation: 'btnSpin 0.6s linear infinite', flexShrink: 0,
  },
} as const;

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  running:   { bg: 'var(--warning-muted)',  fg: 'var(--warning)' },
  completed: { bg: 'var(--success-muted)',  fg: 'var(--success)' },
  failed:    { bg: 'var(--danger-muted)',   fg: 'var(--danger)' },
  stopped:   { bg: 'var(--bg-elevated)',    fg: 'var(--text-tertiary)' },
  pending:   { bg: 'var(--bg-elevated)',    fg: 'var(--text-ghost)' },
};

// ── Local Server Panel ───────────────────────────────────────

function LocalServerPanel({ ticket }: { ticket?: string }): JSX.Element {
  const { addToast } = useToast();
  const [status, setStatus] = useState<LocalServerStatus>({ running: false, port: null, ready: false, startedAt: null, ticket: null, branch: null, logs: [] });
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [envContent, setEnvContent] = useState('');
  const [envOpen, setEnvOpen] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);
  const [envSaved, setEnvSaved] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = (): void => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const poll = useCallback(async () => {
    try {
      const s = await getLocalServerStatus();
      setStatus(s);
      if (!s.running || s.ready) { stopPolling(); setStarting(false); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void poll();
    // Load current env file content
    getLocalServerEnv().then((r) => { if (r.ok && r.content !== undefined) setEnvContent(r.content); }).catch(() => {});
    return stopPolling;
  }, [poll]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [status.logs.length]);

  const handleSaveEnv = useCallback(async () => {
    setEnvSaving(true);
    try {
      const r = await saveLocalServerEnv(envContent);
      if (r.ok) { setEnvSaved(true); setTimeout(() => setEnvSaved(false), 2500); addToast('apps/enterprise/.env saved', 'success'); }
      else addToast(r.error ?? 'Failed to save', 'error');
    } catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
    setEnvSaving(false);
  }, [envContent, addToast]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      // Pass current env content so backend writes it before npm install + nx serve
      const res = await startLocalServer(ticket, envContent);
      if (!res.ok) { addToast(res.error ?? 'Failed to start', 'error'); setStarting(false); return; }
      stopPolling();
      pollRef.current = setInterval(() => void poll(), 3000);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setStarting(false);
    }
  }, [poll, addToast, ticket, envContent]);

  const handleStop = useCallback(async () => {
    setStopping(true);
    stopPolling();
    try {
      await stopLocalServer();
      setStatus((s) => ({ ...s, running: false, ready: false, port: null }));
    } catch { /* ignore */ }
    setStopping(false);
  }, []);

  const localUrl = status.port ? `https://localhost:${status.port}` : null;
  const elapsed = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;

  return (
    <>
      {/* .env editor */}
      <div style={styles.envSection}>
        <div style={styles.envHeader} onClick={() => setEnvOpen((v) => !v)}>
          <span>⚙ apps/enterprise/.env</span>
          <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-tertiary)' }}>
            {envOpen ? 'collapse ▲' : 'edit ▼'}
          </span>
        </div>
        {envOpen && (
          <>
            <textarea
              value={envContent}
              onChange={(e) => setEnvContent(e.target.value)}
              style={styles.envTextarea}
              spellCheck={false}
              placeholder="VITE_APP_API_URL=https://..."
              aria-label="apps/enterprise/.env content"
            />
            <div style={styles.envFooter}>
              {envSaved
                ? <span style={styles.envSaved}>✓ Saved</span>
                : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Changes are also applied automatically on Start</span>
              }
              <button
                type="button"
                style={{ ...styles.previewBtn, background: 'var(--accent-muted)', color: 'var(--accent)', border: '1px solid var(--accent)', opacity: envSaving ? 0.5 : 1 }}
                onClick={() => void handleSaveEnv()}
                disabled={envSaving}
              >
                {envSaving ? 'Saving…' : 'Save .env'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <div style={styles.previewBar}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 1 }}>
          <span style={{ ...styles.liveDot, background: status.ready ? 'var(--success)' : status.running ? 'var(--warning)' : 'var(--text-ghost)', boxShadow: status.ready ? '0 0 6px var(--success)' : status.running ? '0 0 6px var(--warning-muted)' : 'none' }} />
          <span style={styles.previewUrl}>
            {localUrl ?? 'localhost:4200'}
            {status.branch && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, background: 'var(--bg-elevated)', padding: '1px 6px', borderRadius: 4, marginLeft: 8, color: 'var(--text-tertiary)' }}>{status.branch}</span>}
            {starting && !status.ready && <span style={{ color: 'var(--warning)', marginLeft: 8, fontSize: 11 }}>compiling… {elapsed}s</span>}
            {status.ready && <span style={{ color: 'var(--success)', marginLeft: 8, fontSize: 11 }}>✓ ready</span>}
          </span>
        </span>
        <div style={styles.previewBtnRow}>
          {localUrl && <a href={localUrl} target="_blank" rel="noopener noreferrer" style={styles.openBtn}>↗ Open in new tab</a>}
          {status.running || starting ? (
            <button type="button" style={styles.stopBtn} onClick={() => void handleStop()} disabled={stopping}>
              {stopping ? 'Stopping…' : '■ Stop'}
            </button>
          ) : (
            <button type="button" style={{ ...styles.runBtn, padding: 'var(--sp-2) var(--sp-4)', fontSize: 12 }}
              onClick={() => void handleStart()} disabled={starting}>
              {starting ? <><span style={styles.spinner} />Starting…</> : '▶ Start Dev Server'}
            </button>
          )}
        </div>
      </div>

      {/* Iframe when ready, otherwise log output */}
      <div style={styles.iframeWrap}>
        {status.ready && localUrl ? (
          <iframe src={localUrl} style={styles.iframe} title="Local dev server" />
        ) : (
          <div style={{ ...styles.terminal, height: '100%', display: 'flex', flexDirection: 'column' as const }}>
            {status.logs.length === 0 && !starting ? (
              <div style={styles.emptyState}>
                {status.running ? 'Starting dev server…' : 'Click "Start Dev Server" to run the app locally. Takes ~60–90s to compile.'}
              </div>
            ) : (
              <div style={{ padding: 'var(--sp-2) 0', overflowY: 'auto' as const, flex: 1 }}>
                {status.logs.map((line, i) => (
                  <div key={i} style={{ ...styles.logLine, color: line.includes('✓') ? 'var(--success)' : line.includes('error') || line.includes('Error') ? 'var(--danger)' : 'var(--text-secondary)' }}>
                    {line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Web Preview ──────────────────────────────────────────────
// Tab switcher: "Local" (nx serve, localhost) vs "QA" (deployed env).

export function WebPreviewPanel({ refreshTrigger = 0, ticket }: { refreshTrigger?: number; ticket?: string }): JSX.Element {
  const config = useSettingsStore((s) => s.config);
  const fetchConfig = useSettingsStore((s) => s.fetchConfig);
  const [tab, setTab] = useState<'local' | 'qa'>('local');
  const [reloadKey, setReloadKey] = useState(0);
  const [frameBlocked, setFrameBlocked] = useState(false);
  const [activeEnv, setActiveEnv] = useState<'qa' | 'qa1'>('qa');

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  useEffect(() => {
    if (refreshTrigger > 0) { setReloadKey((k) => k + 1); setFrameBlocked(false); }
  }, [refreshTrigger]);

  const qaUrl  = (config['QA_URL']  as string | undefined) ?? '';
  const qa1Url = (config['QA1_URL'] as string | undefined) ?? '';
  const activeQaUrl = activeEnv === 'qa' ? qaUrl : qa1Url;

  return (
    <>
      {/* Tab bar */}
      <div style={{ display: 'inline-flex', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)', overflow: 'hidden', marginBottom: 'var(--sp-3)' }}>
        {(['local', 'qa'] as const).map((t) => (
          <button key={t} type="button"
            style={{ ...styles.previewBtn, border: 'none', borderRadius: 0, background: tab === t ? 'var(--accent-muted)' : 'transparent', color: tab === t ? 'var(--accent)' : 'var(--text-tertiary)', fontWeight: tab === t ? 700 : 400 }}
            onClick={() => setTab(t)}>
            {t === 'local' ? '⚡ Local' : '🌐 QA'}
          </button>
        ))}
      </div>

      {tab === 'local' ? (
        <LocalServerPanel ticket={ticket} />
      ) : (
        /* QA tab */
        <>
          <div style={styles.previewBar}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
              <span style={{ ...styles.liveDot, background: 'var(--success)', boxShadow: '0 0 6px var(--success)' }} />
              <span style={{ ...styles.previewUrl, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{activeQaUrl || 'QA_URL not configured'}</span>
            </span>
            <div style={styles.previewBtnRow}>
              {qa1Url && (
                <div style={{ display: 'inline-flex', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)', overflow: 'hidden' }}>
                  {(['qa', 'qa1'] as const).map((env) => (
                    <button key={env} type="button"
                      style={{ ...styles.previewBtn, border: 'none', borderRadius: 0, background: activeEnv === env ? 'var(--accent-muted)' : 'transparent', color: activeEnv === env ? 'var(--accent)' : 'var(--text-tertiary)' }}
                      onClick={() => { setActiveEnv(env); setFrameBlocked(false); setReloadKey((k) => k + 1); }}>
                      {env.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" style={styles.previewBtn} onClick={() => { setFrameBlocked(false); setReloadKey((k) => k + 1); }}>↻ Reload</button>
              {activeQaUrl && <a href={activeQaUrl} target="_blank" rel="noopener noreferrer" style={styles.openBtn}>↗ Open in new tab</a>}
            </div>
          </div>

          <div style={styles.iframeWrap}>
            {!activeQaUrl ? (
              <div style={styles.previewOffline}>
                <span>QA_URL not configured</span>
                <span style={{ fontSize: 11 }}>Set it in Settings → Config.</span>
              </div>
            ) : frameBlocked ? (
              <div style={styles.previewOffline}>
                <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Embedding blocked (X-Frame-Options)</span>
                <a href={activeQaUrl} target="_blank" rel="noopener noreferrer" style={{ ...styles.openBtn, padding: '6px 16px', fontSize: 12 }}>
                  ↗ Open {activeEnv.toUpperCase()} in new tab
                </a>
              </div>
            ) : (
              <iframe key={`${reloadKey}-${activeEnv}`} src={activeQaUrl} style={styles.iframe} title={`${activeEnv.toUpperCase()} preview`}
                onLoad={(e) => { try { if ((e.target as HTMLIFrameElement).contentDocument === null) setFrameBlocked(true); } catch { setFrameBlocked(true); } }} />
            )}
          </div>
        </>
      )}
    </>
  );
}


// ── Test Ticket Flow ─────────────────────────────────────────
// Runs only Fetch Ticket (quick — gets ticket info) then shows
// the web preview. Explore & Plan / Write Code already ran in
// the real pipeline; no need to redo them here.

function TestTicketFlow(): JSX.Element {
  const startRun = usePlaygroundStore((s) => s.startRun);
  const activeRunId = usePlaygroundStore((s) => s.activeRunId);
  const activeRun = usePlaygroundRun(activeRunId);
  const stopRun = usePlaygroundStore((s) => s.stopRun);
  const { addToast } = useToast();

  const [ticket, setTicket] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll live logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [activeRun?.logs.length]);

  const isRunning = activeRun?.status === 'running';
  const isFetchRun = activeRun?.stage === 'fetch_ticket';
  const summary = activeRun?.status === 'completed' && isFetchRun
    ? activeRun.logs.find((l) => l.message.includes('[Enhancement') || l.message.includes('[Bug') || l.message.includes('[Task'))?.message
      ?? activeRun.logs[activeRun.logs.length - 1]?.message
    : null;

  const handleFetch = async (): Promise<void> => {
    const t = ticket.trim().toUpperCase();
    if (!t || !/^[A-Z]+-\d+$/.test(t)) {
      addToast('Enter a valid ticket ID (e.g. AUT-1234)', 'error');
      return;
    }
    setSubmitting(true);
    const res = await startRun('fetch_ticket', t, '');
    setSubmitting(false);
    if (!res.ok) addToast(res.error ?? 'Failed to fetch ticket', 'error');
  };

  const fetchDone = isFetchRun && activeRun?.status === 'completed';
  const col = activeRun && isFetchRun ? (STATUS_COLORS[activeRun.status] ?? STATUS_COLORS.pending) : STATUS_COLORS.pending;

  return (
    <div style={styles.panel}>
      <div style={styles.title}>Test a Ticket</div>

      {/* Ticket input */}
      <div style={styles.ticketBar}>
        <input
          type="text"
          value={ticket}
          onChange={(e) => setTicket(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isRunning) void handleFetch(); }}
          placeholder="e.g. AUT-1234"
          spellCheck={false}
          style={styles.ticketInput}
          disabled={isRunning}
          aria-label="Ticket ID"
        />
        {isRunning && isFetchRun ? (
          <button type="button" style={styles.stopBtn} onClick={() => activeRun && void stopRun(activeRun.runId)}>
            ■ Stop
          </button>
        ) : (
          <button
            type="button"
            style={{ ...styles.runBtn, ...(submitting ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
            onClick={() => void handleFetch()}
            disabled={submitting || isRunning}
          >
            {submitting ? <><span style={styles.spinner} />Fetching…</> : '▶ Fetch Ticket'}
          </button>
        )}
      </div>

      {/* Fetch result card */}
      {activeRun && isFetchRun && (
        <div style={{ ...styles.stageCard, marginBottom: 'var(--sp-4)' }}>
          <div style={styles.stageCardHeader}>
            <span style={{ ...styles.stageCardNum, background: col.bg, color: col.fg }}>
              {activeRun.status === 'completed' ? '✓' : activeRun.status === 'failed' ? '✗' : '⟳'}
            </span>
            <span style={styles.stageCardLabel}>
              {ticket || activeRun.ticket} — Fetch Ticket
            </span>
            <span style={styles.stageCardTime}>
              {activeRun.finishedAt && activeRun.startedAt
                ? `${Math.round((activeRun.finishedAt - activeRun.startedAt) / 1000)}s`
                : isRunning ? <ElapsedText startedAt={activeRun.startedAt} /> : ''}
            </span>
          </div>

          {/* Summary line */}
          {summary && (
            <div style={styles.stageSummary}>{summary}</div>
          )}

          {/* Live logs while running */}
          {isRunning && (
            <div style={{ ...styles.terminal, height: 160 }} role="log">
              {activeRun.logs.map((log) => (
                <div key={log.id} style={styles.logLine}>{log.message}</div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {(!activeRun || !isFetchRun) && (
        <div style={{ padding: 'var(--sp-5)', textAlign: 'center', color: 'var(--text-ghost)', fontSize: 13 }}>
          Enter a ticket ID and click Fetch Ticket to load its details, then test the running preview below.
        </div>
      )}

      {/* Web Preview — always visible */}
      <div style={{ ...styles.panel, padding: 'var(--sp-4)', marginTop: 'var(--sp-2)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 'var(--sp-3)' }}>
          Web Preview
          {fetchDone && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 8 }}>port {4200}</span>}
        </div>
        <WebPreviewPanel refreshTrigger={fetchDone ? (activeRun?.finishedAt ?? 0) : 0} ticket={ticket || activeRun?.ticket || undefined} />
      </div>
    </div>
  );
}

function ElapsedText({ startedAt }: { startedAt: number }): JSX.Element {
  const elapsed = useElapsed(startedAt);
  return <>{elapsed}</>;
}

// ── Single Stage Panel (existing) ────────────────────────────

interface SingleStagePanelProps {
  /** When set, the ticket field is locked to this value (read-only display)
   * instead of a free-text input, and re-syncs if this prop changes — used
   * when embedding this panel scoped to whatever ticket is already open
   * elsewhere (e.g. the Dashboard's Sandbox tab). */
  lockedTicket?: string;
  /** Seeds the stage picker's initial selection. Defaults to
   * `PLAYGROUND_ALLOWED_STAGES[0]` ('fetch_ticket'), matching today's
   * standalone-page behavior when omitted. */
  initialStage?: StageName;
}

export function SingleStagePanel({ lockedTicket, initialStage }: SingleStagePanelProps = {}): JSX.Element {
  const prefillStage = usePlaygroundStore((s) => s.prefillStage);
  const prefillTicket = usePlaygroundStore((s) => s.prefillTicket);
  const clearPrefill = usePlaygroundStore((s) => s.clearPrefill);
  const startRun = usePlaygroundStore((s) => s.startRun);
  const activeRunId = usePlaygroundStore((s) => s.activeRunId);
  const activeRun = usePlaygroundRun(activeRunId);
  const setNavView = useNavigationStore((s) => s.setView);
  const { addToast } = useToast();

  const [stage, setStage] = useState<StageName>(initialStage ?? PLAYGROUND_ALLOWED_STAGES[0]);
  const [ticket, setTicket] = useState(lockedTicket ?? '');
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!prefillStage && !prefillTicket) return;
    if (prefillStage && PLAYGROUND_ALLOWED_STAGES.includes(prefillStage)) setStage(prefillStage);
    if (prefillTicket) setTicket(prefillTicket);
    clearPrefill();
  }, [prefillStage, prefillTicket, clearPrefill]);

  // Re-sync when embedded and the caller's active ticket changes (e.g. the
  // Dashboard sidebar switches tickets while the Sandbox tab stays mounted).
  useEffect(() => {
    if (lockedTicket !== undefined) setTicket(lockedTicket);
  }, [lockedTicket]);

  const handleStart = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const result = await startRun(stage, ticket.trim().toUpperCase() || null, instruction.trim());
      if (!result.ok) addToast(result.error ?? 'Failed to start Playground run', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenInFullPlayground = (): void => {
    usePlaygroundStore.getState().prefill(stage, ticket.trim().toUpperCase() || undefined);
    setNavView('playground');
  };

  const stageOptions = STAGE_INFO.filter((info) => PLAYGROUND_ALLOWED_STAGES.includes(info.stage));

  return (
    <>
      <div style={styles.panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-4)' }}>
          <div style={{ ...styles.title, marginBottom: 0 }}>Run a stage</div>
          {lockedTicket !== undefined && (
            <button type="button" style={styles.openFullBtn} onClick={handleOpenInFullPlayground}>
              Open in full Playground →
            </button>
          )}
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Stage</label>
          <div style={styles.stagePicker}>
            {stageOptions.map((info) => (
              <button key={info.stage} type="button"
                style={{ ...styles.stageBtn, ...(stage === info.stage ? styles.stageBtnActive : {}) }}
                onClick={() => setStage(info.stage)} aria-pressed={stage === info.stage}>
                {info.label}
              </button>
            ))}
          </div>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="pg-ticket">Borrow context from ticket{lockedTicket === undefined ? ' (optional)' : ''}</label>
          {lockedTicket !== undefined ? (
            <div id="pg-ticket" style={styles.lockedTicket} aria-readonly="true">{ticket || '(no active ticket)'}</div>
          ) : (
            <input id="pg-ticket" type="text" value={ticket} onChange={(e) => setTicket(e.target.value)}
              placeholder="e.g. AUT-1234" spellCheck={false} style={styles.input} />
          )}
          <div style={styles.hint}>
            {lockedTicket !== undefined
              ? "Locked to the current ticket — read-only, never writes back to its real state."
              : "Read-only — clones that ticket's prior-stage data. Never writes back to its real state."}
          </div>
        </div>
        <div style={styles.field}>
          <label style={styles.label} htmlFor="pg-instruction">Custom instruction (optional)</label>
          <textarea id="pg-instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)}
            placeholder="Override the stage's default instruction for this run only..." style={styles.textarea} />
        </div>
        <button type="button"
          style={{ ...styles.runBtn, ...(submitting ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
          onClick={() => void handleStart()} disabled={submitting}>
          {submitting ? 'Starting…' : 'Run in Playground'}
        </button>
      </div>

      <div style={styles.panel}>
        <div style={styles.title}>Live output</div>
        {activeRun && (
          <div style={styles.statusRow}>
            <span style={{ ...styles.statusBadge, background: STATUS_COLORS[activeRun.status]?.bg, color: STATUS_COLORS[activeRun.status]?.fg }}>
              {activeRun.status}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {STAGE_INFO.find((i) => i.stage === activeRun.stage)?.label ?? activeRun.stage}
              {activeRun.ticket ? ` · ${activeRun.ticket}` : ''}
            </span>
          </div>
        )}
        <div style={styles.terminal} role="log" aria-live="polite">
          {!activeRun || activeRun.logs.length === 0 ? (
            <div style={styles.emptyState}>{activeRun ? 'Waiting for output…' : 'No run yet — start one above.'}</div>
          ) : (
            activeRun.logs.map((log) => (
              <div key={log.id} style={styles.logLine}>{log.message}</div>
            ))
          )}
        </div>
      </div>

      <div style={styles.panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-3)' }}>
          <div style={styles.title} aria-hidden>Web Preview</div>
        </div>
        <WebPreviewPanel />
      </div>
    </>
  );
}

// ── Run History ──────────────────────────────────────────────

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function RunHistory({ onView }: { onView: (runId: string) => void }): JSX.Element {
  const [runs, setRuns] = useState<PlaygroundRunRecord[]>([]);

  useEffect(() => {
    getPlaygroundRuns().then((res) => {
      if (res.ok) setRuns(res.runs.slice(0, 10));
    }).catch(() => { /* ignore */ });
  }, []);

  if (runs.length === 0) return <></>;

  return (
    <div style={styles.panel}>
      <div style={styles.title}>Recent Runs</div>
      {runs.map((run) => {
        const col = STATUS_COLORS[run.status] ?? STATUS_COLORS.pending;
        const label = STAGE_INFO.find((s) => s.stage === run.stage)?.label ?? run.stage;
        return (
          <button key={run.runId} type="button" style={styles.historyItem}
            onClick={() => onView(run.runId)}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
            <span style={{ ...styles.historyDot, background: col.fg }} />
            <span style={styles.historyLabel}>
              {run.ticket ? <strong>{run.ticket}</strong> : <em>no ticket</em>} — {label}
            </span>
            <span style={styles.historyTime}>{run.startedAt ? timeAgo(run.startedAt) : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────

export function PlaygroundPage(): JSX.Element {
  const [mode, setMode] = useState<'test' | 'single'>('test');
  const viewRun = usePlaygroundStore((s) => s.viewRun);

  const handleViewRun = (runId: string): void => {
    void viewRun(runId);
    setMode('single');
  };

  return (
    <div style={styles.container}>
      <div style={styles.banner} role="status">
        Playground — sandboxed. No real deploys, pushes, or notifications are performed here.
      </div>

      {/* Mode toggle */}
      <div style={styles.modeToggle}>
        <button type="button"
          style={{ ...styles.modeBtn, ...(mode === 'test' ? styles.modeBtnActive : {}) }}
          onClick={() => setMode('test')} aria-pressed={mode === 'test'}>
          Test Ticket
        </button>
        <button type="button"
          style={{ ...styles.modeBtn, ...(mode === 'single' ? styles.modeBtnActive : {}) }}
          onClick={() => setMode('single')} aria-pressed={mode === 'single'}>
          Single Stage
        </button>
      </div>

      {mode === 'test' ? <TestTicketFlow /> : <SingleStagePanel />}

      <RunHistory onView={handleViewRun} />
    </div>
  );
}
