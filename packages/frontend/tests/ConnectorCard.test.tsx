// =====================================================================
// ConnectorCard Component Tests
// =====================================================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectorCard } from '../src/components/settings/ConnectorCard';
import type { OAuthInfo } from '../src/components/settings/ConnectorCard';
import type { ConnectorStatus, TestConnectionResult } from '../src/store/settings';

// ── Helpers ────────────────────────────────────────────────────────

/** Minimal required props for the ConnectorCard component. */
function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Figma',
    icon: 'figma',
    description: 'Auto-fetch Figma design files.',
    status: 'disconnected' as ConnectorStatus,
    onTest: vi.fn(),
    onConfigure: vi.fn(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ConnectorCard', () => {
  // ── 1. Not connected ─────────────────────────────────────────

  describe('not connected (OAuth)', () => {
    it('shows "Not connected" badge when oauthStatus is NOT_CONNECTED', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'NOT_CONNECTED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.getByText('Not connected')).toBeDefined();
    });

    it('shows Connect button when supportsOAuth and NOT_CONNECTED', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'NOT_CONNECTED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: /Connect Figma via OAuth/i })).toBeDefined();
    });

    it('does not show Disconnect button when NOT_CONNECTED', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'NOT_CONNECTED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Disconnect/i })).toBeNull();
    });

    it('does not show Connect button when supportsOAuth is false', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth={false}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Connect Figma via OAuth/i })).toBeNull();
    });
  });

  // ── 2. Connected via OAuth ───────────────────────────────────

  describe('connected via OAuth', () => {
    const connectedOAuthInfo: OAuthInfo = {
      oauthStatus: 'CONNECTED',
      expiresAt: Date.now() + 3_600_000, // 1 hour from now
      metadata: { email: 'user@example.com' },
    };

    it('shows "Connected" green badge', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={connectedOAuthInfo}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.getByText('Connected')).toBeDefined();
    });

    it('shows Disconnect button', () => {
      const onDisconnect = vi.fn();

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={connectedOAuthInfo}
          onOAuthDisconnect={onDisconnect}
        />,
      );

      const btn = screen.getByRole('button', { name: /Disconnect Figma/i });
      expect(btn).toBeDefined();
    });

    it('calls onOAuthDisconnect when Disconnect is clicked', () => {
      const onDisconnect = vi.fn();

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={connectedOAuthInfo}
          onOAuthDisconnect={onDisconnect}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Disconnect Figma/i }));
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    it('shows account identity (email)', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={connectedOAuthInfo}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.getByText('user@example.com')).toBeDefined();
    });

    it('shows expiry countdown text', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={connectedOAuthInfo}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      // With expiresAt 1 hour from now, should show "Refreshes in 1h 0m"
      expect(screen.getByText(/Refreshes in/)).toBeDefined();
    });

    it('does not show Connect button when already connected', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={connectedOAuthInfo}
          onOAuthConnect={vi.fn()}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Connect Figma via OAuth/i })).toBeNull();
    });
  });

  // ── 3. Refreshing ────────────────────────────────────────────

  describe('refreshing', () => {
    it('shows "Refreshing\u2026" badge', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'REFRESHING' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.getByText('Refreshing\u2026')).toBeDefined();
    });

    it('shows Disconnect button during refresh (REFRESHING counts as connected)', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'REFRESHING' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: /Disconnect Figma/i })).toBeDefined();
    });
  });

  // ── 4. Re-auth required ──────────────────────────────────────

  describe('re-auth required', () => {
    it('shows "Re-auth required" amber badge', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'RE_AUTH_REQUIRED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.getByText('Re-auth required')).toBeDefined();
    });

    it('shows Re-authorize button', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'RE_AUTH_REQUIRED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: /Re-authorize Figma/i })).toBeDefined();
    });

    it('calls onOAuthConnect when Re-authorize is clicked', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'RE_AUTH_REQUIRED' };
      const onConnect = vi.fn();

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={onConnect}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Re-authorize Figma/i }));
      expect(onConnect).toHaveBeenCalledTimes(1);
    });

    it('does not show Connect button (shows Re-authorize instead)', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'RE_AUTH_REQUIRED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Connect Figma via OAuth/i })).toBeNull();
    });

    it('does not show Disconnect button', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'RE_AUTH_REQUIRED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Disconnect Figma/i })).toBeNull();
    });
  });

  // ── 5. Revoked ───────────────────────────────────────────────

  describe('revoked', () => {
    it('shows "Revoked" red badge', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'REVOKED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.getByText('Revoked')).toBeDefined();
    });

    it('shows Re-authorize button when revoked', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'REVOKED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.getByRole('button', { name: /Re-authorize Figma/i })).toBeDefined();
    });

    it('does not show Disconnect button when revoked', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'REVOKED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Disconnect Figma/i })).toBeNull();
    });
  });

  // ── 6. Connected via PAT ─────────────────────────────────────

  describe('connected via PAT', () => {
    it('shows "Connected via PAT" badge', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'PAT' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
        />,
      );

      expect(screen.getByText('Connected via PAT')).toBeDefined();
    });

    it('does not show Connect button when PAT is active', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'PAT' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Connect Figma via OAuth/i })).toBeNull();
    });

    it('does not show Disconnect or Re-authorize buttons when PAT is active', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'PAT' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
          onOAuthDisconnect={vi.fn()}
        />,
      );

      expect(screen.queryByRole('button', { name: /Disconnect Figma/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Re-authorize Figma/i })).toBeNull();
    });
  });

  // ── Non-OAuth fallback badge ─────────────────────────────────

  describe('non-OAuth fallback badge', () => {
    it('shows "Connected" original badge when supportsOAuth is false and status is connected', () => {
      render(
        <ConnectorCard
          {...baseProps({ status: 'connected' as ConnectorStatus })}
          supportsOAuth={false}
        />,
      );

      expect(screen.getByText('Connected')).toBeDefined();
    });

    it('shows "Disconnected" original badge when supportsOAuth is false and status is disconnected', () => {
      render(
        <ConnectorCard
          {...baseProps({ status: 'disconnected' as ConnectorStatus })}
          supportsOAuth={false}
        />,
      );

      expect(screen.getByText('Disconnected')).toBeDefined();
    });

    it('shows "Coming Soon" badge and hides Test/Configure buttons', () => {
      render(
        <ConnectorCard
          {...baseProps({ status: 'coming_soon' as ConnectorStatus })}
          supportsOAuth={false}
        />,
      );

      expect(screen.getByText('Coming Soon')).toBeDefined();
      expect(screen.queryByRole('button', { name: /Test/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Configure/i })).toBeNull();
    });
  });

  // ── Connect button interactions ──────────────────────────────

  describe('connect button interactions', () => {
    it('calls onOAuthConnect when Connect is clicked', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'NOT_CONNECTED' };
      const onConnect = vi.fn();

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={onConnect}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Connect Figma via OAuth/i }));
      expect(onConnect).toHaveBeenCalledTimes(1);
    });

    it('shows "Connecting..." text and disables button when oauthLaunching is true', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'NOT_CONNECTED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
          oauthLaunching
        />,
      );

      const btn = screen.getByRole('button', { name: /Connect Figma via OAuth/i });
      expect(btn).toBeDisabled();
      expect(screen.getByText('Connecting...')).toBeDefined();
    });

    it('shows "Re-authorizing..." text when oauthLaunching during re-auth', () => {
      const oauthInfo: OAuthInfo = { oauthStatus: 'RE_AUTH_REQUIRED' };

      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={oauthInfo}
          onOAuthConnect={vi.fn()}
          oauthLaunching
        />,
      );

      const btn = screen.getByRole('button', { name: /Re-authorize Figma/i });
      expect(btn).toBeDisabled();
      expect(screen.getByText('Re-authorizing...')).toBeDefined();
    });
  });

  // ── Test connection button & result ──────────────────────────

  describe('test connection', () => {
    it('shows Test button and calls onTest when clicked', () => {
      const onTest = vi.fn();

      render(<ConnectorCard {...baseProps({ onTest })} />);

      const btn = screen.getByRole('button', { name: /Test Figma connection/i });
      fireEvent.click(btn);
      expect(onTest).toHaveBeenCalledTimes(1);
    });

    it('shows "Testing..." and disables button when test is loading', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          testResult={{ loading: true, result: null }}
        />,
      );

      const btn = screen.getByRole('button', { name: /Test Figma connection/i });
      expect(btn).toBeDisabled();
      expect(screen.getByText(/Testing/)).toBeDefined();
    });

    it('shows success message when test passes', () => {
      const result: TestConnectionResult = { ok: true, message: 'All good' };

      render(
        <ConnectorCard
          {...baseProps()}
          testResult={{ loading: false, result }}
        />,
      );

      expect(screen.getByText('All good')).toBeDefined();
    });

    it('shows error message when test fails', () => {
      const result: TestConnectionResult = { ok: false, message: 'Timeout after 5s' };

      render(
        <ConnectorCard
          {...baseProps()}
          testResult={{ loading: false, result }}
        />,
      );

      expect(screen.getByText('Timeout after 5s')).toBeDefined();
    });
  });

  // ── PAT fallback disclosure ──────────────────────────────────

  describe('PAT fallback disclosure', () => {
    it('shows "Use API token instead" toggle when patFallbackContent is provided', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={{ oauthStatus: 'NOT_CONNECTED' }}
          patFallbackContent={<div>PAT input here</div>}
        />,
      );

      expect(screen.getByText(/Use API token instead/)).toBeDefined();
    });

    it('reveals PAT fallback content when toggle is clicked', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={{ oauthStatus: 'NOT_CONNECTED' }}
          patFallbackContent={<div>PAT input here</div>}
        />,
      );

      // Content should not be visible initially
      expect(screen.queryByText('PAT input here')).toBeNull();

      // Click the toggle
      fireEvent.click(screen.getByText(/Use API token instead/));

      // Now the content should be visible
      expect(screen.getByText('PAT input here')).toBeDefined();
    });

    it('hides PAT fallback content when toggle is clicked again', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={{ oauthStatus: 'NOT_CONNECTED' }}
          patFallbackContent={<div>PAT input here</div>}
        />,
      );

      // Open
      fireEvent.click(screen.getByText(/Use API token instead/));
      expect(screen.getByText('PAT input here')).toBeDefined();

      // Close
      fireEvent.click(screen.getByText(/Hide API token/));
      expect(screen.queryByText('PAT input here')).toBeNull();
    });

    it('does not show PAT toggle when patFallbackContent is not provided', () => {
      render(
        <ConnectorCard
          {...baseProps()}
          supportsOAuth
          oauthInfo={{ oauthStatus: 'NOT_CONNECTED' }}
        />,
      );

      expect(screen.queryByText(/Use API token instead/)).toBeNull();
    });
  });

  // ── Basic rendering ──────────────────────────────────────────

  describe('basic rendering', () => {
    it('renders connector name and description', () => {
      render(<ConnectorCard {...baseProps()} />);

      expect(screen.getByText('Figma')).toBeDefined();
      expect(screen.getByText('Auto-fetch Figma design files.')).toBeDefined();
    });

    it('renders Configure button', () => {
      render(<ConnectorCard {...baseProps()} />);

      expect(screen.getByRole('button', { name: /Configure Figma/i })).toBeDefined();
    });

    it('calls onConfigure when Configure is clicked', () => {
      const onConfigure = vi.fn();

      render(<ConnectorCard {...baseProps({ onConfigure })} />);

      fireEvent.click(screen.getByRole('button', { name: /Configure Figma/i }));
      expect(onConfigure).toHaveBeenCalledTimes(1);
    });
  });
});
