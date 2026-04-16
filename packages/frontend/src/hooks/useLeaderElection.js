// ═══════════════════════════════════════════════════════════════
// useLeaderElection — BroadcastChannel-based leader election
// Port from html.js crossTab leader election (lines 5120-5296)
// Only leader tab polls server / reconnects SSE; others stay passive
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useCallback } from 'react';
/** Leader heartbeat interval (5s) — same as html.js leaderCheckInterval */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** Stale leader timeout (10s) — if no heartbeat in 10s, leader is considered dead */
const STALE_LEADER_TIMEOUT_MS = 10_000;
/**
 * BroadcastChannel-based leader election hook.
 *
 * Features:
 * - Uses BroadcastChannel API for cross-tab communication
 * - Leader heartbeat every 5s
 * - Auto-promote on leader tab close/crash (detect missing heartbeat after 10s)
 * - Only leader tab polls server / reconnects SSE (others stay passive)
 * - Graceful cleanup on unmount (resign leadership, close channel)
 * - Fallback for browsers without BroadcastChannel (always leader)
 *
 * Ported from html.js crossTab leader election (lines 5166-5236).
 *
 * @param channelName - Name of the BroadcastChannel (default: "mi-dev-agent-leader")
 */
export function useLeaderElection(channelName = 'mi-dev-agent-leader') {
    const [isLeader, setIsLeader] = useState(false);
    // Unique tab identifier
    const tabIdRef = useRef(`${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    const channelRef = useRef(null);
    const heartbeatTimerRef = useRef(null);
    const leaderTabIdRef = useRef(null);
    const lastLeaderHeartbeatRef = useRef(0);
    const isLeaderRef = useRef(false);
    const mountedRef = useRef(true);
    // Check if BroadcastChannel is available
    const hasBroadcastChannel = typeof BroadcastChannel !== 'undefined';
    // Update both state and ref
    const setLeaderState = useCallback((leader) => {
        isLeaderRef.current = leader;
        if (mountedRef.current) {
            setIsLeader(leader);
        }
    }, []);
    // Send a message to other tabs
    const broadcast = useCallback((msg) => {
        if (channelRef.current) {
            try {
                channelRef.current.postMessage(msg);
            }
            catch {
                // Channel might be closed
            }
        }
    }, []);
    // Claim leadership
    const claimLeadership = useCallback(() => {
        const tabId = tabIdRef.current;
        leaderTabIdRef.current = tabId;
        lastLeaderHeartbeatRef.current = Date.now();
        setLeaderState(true);
        broadcast({
            type: 'claim',
            tabId,
            timestamp: Date.now(),
        });
    }, [setLeaderState, broadcast]);
    // Resign leadership
    const resignLeadership = useCallback(() => {
        if (!isLeaderRef.current)
            return;
        setLeaderState(false);
        leaderTabIdRef.current = null;
        broadcast({
            type: 'resign',
            tabId: tabIdRef.current,
            timestamp: Date.now(),
        });
    }, [setLeaderState, broadcast]);
    // Send heartbeat (only if leader)
    const sendHeartbeat = useCallback(() => {
        if (!isLeaderRef.current)
            return;
        const now = Date.now();
        lastLeaderHeartbeatRef.current = now;
        broadcast({
            type: 'heartbeat',
            tabId: tabIdRef.current,
            timestamp: now,
        });
    }, [broadcast]);
    // Check if current leader is stale and attempt takeover
    const checkLeaderHealth = useCallback(() => {
        const now = Date.now();
        const tabId = tabIdRef.current;
        // If we are the leader, just send heartbeat
        if (isLeaderRef.current) {
            sendHeartbeat();
            return;
        }
        // If no leader or leader heartbeat is stale, try to claim
        if (leaderTabIdRef.current === null ||
            (now - lastLeaderHeartbeatRef.current) > STALE_LEADER_TIMEOUT_MS) {
            claimLeadership();
            return;
        }
        // Otherwise we are a follower -- do nothing
        void tabId;
    }, [sendHeartbeat, claimLeadership]);
    // Handle incoming messages from other tabs
    const handleMessage = useCallback((msg) => {
        const tabId = tabIdRef.current;
        // Ignore our own messages
        if (msg.tabId === tabId)
            return;
        switch (msg.type) {
            case 'claim': {
                // Another tab claimed leadership
                leaderTabIdRef.current = msg.tabId;
                lastLeaderHeartbeatRef.current = msg.timestamp;
                // If we thought we were leader, we yield to the claimer
                // Simple conflict resolution: latest claim wins
                if (isLeaderRef.current) {
                    // Tie-break by tab ID (lexicographic) to avoid flip-flopping
                    if (msg.tabId > tabId) {
                        setLeaderState(false);
                    }
                    else {
                        // We win the tie-break -- re-claim
                        claimLeadership();
                    }
                }
                else {
                    setLeaderState(false);
                }
                break;
            }
            case 'heartbeat': {
                // Leader is alive
                leaderTabIdRef.current = msg.tabId;
                lastLeaderHeartbeatRef.current = msg.timestamp;
                // If we somehow think we're leader but another tab is heartbeating,
                // yield if their tabId wins tie-break
                if (isLeaderRef.current && msg.tabId !== tabIdRef.current) {
                    if (msg.tabId > tabId) {
                        setLeaderState(false);
                    }
                }
                break;
            }
            case 'resign': {
                // Leader resigned -- try to claim if we're visible
                if (leaderTabIdRef.current === msg.tabId) {
                    leaderTabIdRef.current = null;
                    // If our tab is visible, claim leadership
                    if (typeof document === 'undefined' || !document.hidden) {
                        claimLeadership();
                    }
                }
                break;
            }
        }
    }, [setLeaderState, claimLeadership]);
    useEffect(() => {
        mountedRef.current = true;
        // ── Fallback: No BroadcastChannel support ──
        if (!hasBroadcastChannel) {
            // Always be leader if BroadcastChannel isn't available
            setLeaderState(true);
            return () => {
                mountedRef.current = false;
            };
        }
        // ── Set up BroadcastChannel ──
        try {
            const channel = new BroadcastChannel(channelName);
            channelRef.current = channel;
            channel.onmessage = (e) => {
                if (e.data && typeof e.data === 'object' && 'type' in e.data) {
                    handleMessage(e.data);
                }
            };
        }
        catch {
            // BroadcastChannel constructor failed -- fallback to always leader
            setLeaderState(true);
            return () => {
                mountedRef.current = false;
            };
        }
        // ── Initial leadership claim attempt ──
        // Small delay to let other tabs announce themselves
        const initialTimer = setTimeout(() => {
            if (mountedRef.current) {
                checkLeaderHealth();
            }
        }, 100);
        // ── Start heartbeat/health check interval ──
        heartbeatTimerRef.current = setInterval(() => {
            if (mountedRef.current) {
                checkLeaderHealth();
            }
        }, HEARTBEAT_INTERVAL_MS);
        // ── Visibility change handler ──
        const handleVisibility = () => {
            if (!mountedRef.current)
                return;
            if (document.hidden) {
                // Hidden tab: resign leadership so a visible tab can take over
                if (isLeaderRef.current) {
                    resignLeadership();
                }
            }
            else {
                // Becoming visible: check if leadership is available
                checkLeaderHealth();
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);
        // ── Cleanup on unmount ──
        return () => {
            mountedRef.current = false;
            clearTimeout(initialTimer);
            if (heartbeatTimerRef.current !== null) {
                clearInterval(heartbeatTimerRef.current);
                heartbeatTimerRef.current = null;
            }
            document.removeEventListener('visibilitychange', handleVisibility);
            // Resign leadership before closing
            if (isLeaderRef.current) {
                resignLeadership();
            }
            // Close the BroadcastChannel
            if (channelRef.current) {
                try {
                    channelRef.current.close();
                }
                catch {
                    // Ignore close errors
                }
                channelRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelName, hasBroadcastChannel]);
    return { isLeader };
}
export default useLeaderElection;
