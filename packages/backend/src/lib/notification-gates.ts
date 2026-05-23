// notification-gates.ts -- Channel toggle check for pipeline stages.
//
// Bridges to packages/agent's notification-config so the per-gate Jira/Slack
// toggles configured in the UI are honored when stages decide whether to post.
// If the underlying module fails to load, isChannelEnabled returns true so the
// pipeline keeps notifying (matching the pre-gate behavior).

type ChannelChecker = (gate: string, channel: string) => boolean;

let impl: ChannelChecker = () => true;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nc = require('../../../agent/dist/lib/notification-config');
  if (typeof nc?.isChannelEnabled === 'function') {
    impl = nc.isChannelEnabled as ChannelChecker;
  }
} catch {
  /* keep default (treat all channels as enabled) */
}

export const isChannelEnabled: ChannelChecker = (gate, channel) => impl(gate, channel);
