// ═══════════════════════════════════════════════════════════════
// MI Dev Agent — Jira API Type Definitions
// ═══════════════════════════════════════════════════════════════
//
// Derived from: lib/jira.js, stages/fetch-ticket.js
// Covers Jira REST API v3 response shapes used by the agent.
// ═══════════════════════════════════════════════════════════════

import type { AdfNode } from './adf';

/** Jira user account (assignee, reporter, comment author, etc.) */
export interface JiraUser {
  /** Atlassian account ID (opaque string) */
  accountId: string;
  /** Human-readable display name */
  displayName: string;
  /** Whether the account is active */
  active?: boolean;
  /** Email address (may be absent depending on Jira permissions) */
  emailAddress?: string;
  /** Avatar URLs keyed by size (e.g., "48x48") */
  avatarUrls?: Record<string, string>;
  /** Timezone of the user */
  timeZone?: string;
  /** Account type: "atlassian", "app", "customer" */
  accountType?: string;
  /** Self URL for this user resource */
  self?: string;
  [key: string]: unknown;
}

/** Jira issue status (e.g., "To Do", "In Progress", "Done") */
export interface JiraStatus {
  /** Status ID */
  id: string;
  /** Status name (e.g., "In Progress") */
  name: string;
  /** Status description */
  description?: string;
  /** Status category (broader grouping) */
  statusCategory?: {
    id: number;
    key: string;
    name: string;
    colorName: string;
  };
  /** Self URL */
  self?: string;
  [key: string]: unknown;
}

/** Jira issue type (e.g., "Bug", "Story", "Task", "Epic") */
export interface JiraIssueType {
  /** Issue type ID */
  id: string;
  /** Issue type name */
  name: string;
  /** Issue type description */
  description?: string;
  /** Whether this is a subtask type */
  subtask?: boolean;
  /** Icon URL */
  iconUrl?: string;
  /** Self URL */
  self?: string;
  [key: string]: unknown;
}

/** Jira priority (e.g., "Highest", "High", "Medium", "Low", "Lowest") */
export interface JiraPriority {
  /** Priority ID */
  id: string;
  /** Priority name */
  name: string;
  /** Priority description */
  description?: string;
  /** Icon URL */
  iconUrl?: string;
  /** Self URL */
  self?: string;
  [key: string]: unknown;
}

/** Jira issue attachment metadata */
export interface JiraAttachment {
  /** Attachment ID */
  id: string;
  /** Original filename */
  filename: string;
  /** Download URL for the attachment content */
  content: string;
  /** MIME type (e.g., "image/png", "application/json") */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Author who uploaded the attachment */
  author?: JiraUser;
  /** Upload timestamp (ISO 8601) */
  created?: string;
  /** Self URL */
  self?: string;
  [key: string]: unknown;
}

/** Jira comment on an issue */
export interface JiraComment {
  /** Comment ID */
  id: string;
  /** Comment body in ADF format */
  body: AdfNode;
  /** Author who wrote the comment */
  author?: JiraUser;
  /** Author who last updated the comment */
  updateAuthor?: JiraUser;
  /** Creation timestamp (ISO 8601) */
  created: string;
  /** Last update timestamp (ISO 8601) */
  updated?: string;
  /** Self URL */
  self?: string;
  [key: string]: unknown;
}

/** Jira issue link type descriptor (e.g., "Blocks", "is blocked by") */
export interface JiraLinkType {
  /** Link type ID */
  id: string;
  /** Link type name (e.g., "Blocks") */
  name: string;
  /** Inward description (e.g., "is blocked by") */
  inward: string;
  /** Outward description (e.g., "blocks") */
  outward: string;
  /** Self URL */
  self?: string;
  [key: string]: unknown;
}

/** Jira issue link connecting two issues */
export interface JiraIssueLink {
  /** Link ID */
  id: string;
  /** Link type descriptor */
  type: JiraLinkType;
  /** The outward-linked issue (present if this link is outward) */
  outwardIssue?: JiraIssue;
  /** The inward-linked issue (present if this link is inward) */
  inwardIssue?: JiraIssue;
  /** Self URL */
  self?: string;
  [key: string]: unknown;
}

/** Jira workflow transition (used by jira.transition()) */
export interface JiraTransition {
  /** Transition ID (used in POST body) */
  id: string;
  /** Transition name (e.g., "Start Progress", "Done") */
  name: string;
  /** Target status after this transition */
  to?: JiraStatus;
  /** Whether the transition has a screen */
  hasScreen?: boolean;
  /** Whether the transition is global */
  isGlobal?: boolean;
  /** Whether the transition is an initial transition */
  isInitial?: boolean;
  /** Whether the transition is conditional */
  isConditional?: boolean;
  [key: string]: unknown;
}

/** Jira changelog entry (from issue history) */
export interface JiraChangelog {
  /** Changelog entry ID */
  id: string;
  /** Author who made the change */
  author?: JiraUser;
  /** Timestamp of the change (ISO 8601) */
  created: string;
  /** List of individual field changes */
  items: ReadonlyArray<{
    field: string;
    fieldtype: string;
    fieldId?: string;
    from: string | null;
    fromString: string | null;
    to: string | null;
    toString: string | null;
  }>;
  [key: string]: unknown;
}

/**
 * Jira issue fields object.
 * Contains all standard and custom fields returned by GET /rest/api/3/issue/{key}.
 */
export interface JiraFields {
  /** Issue summary (title) */
  summary: string;
  /** Issue description in ADF format */
  description: AdfNode | null;
  /** Current status */
  status: JiraStatus;
  /** Issue type */
  issuetype: JiraIssueType;
  /** Priority */
  priority: JiraPriority;
  /** Assignee (may be null if unassigned) */
  assignee: JiraUser | null;
  /** Reporter */
  reporter: JiraUser | null;
  /** Creation timestamp (ISO 8601) */
  created: string;
  /** Last update timestamp (ISO 8601) */
  updated: string;
  /** Resolution date (ISO 8601, null if unresolved) */
  resolutiondate: string | null;
  /** Labels */
  labels: readonly string[];
  /** Components */
  components: ReadonlyArray<{ id: string; name: string; [key: string]: unknown }>;
  /** Fix versions */
  fixVersions: ReadonlyArray<{ id: string; name: string; [key: string]: unknown }>;
  /** Attached files */
  attachment: readonly JiraAttachment[];
  /** Issue links */
  issuelinks: readonly JiraIssueLink[];
  /** Parent issue (for subtasks / child issues) */
  parent?: {
    key: string;
    fields: {
      summary: string;
      status?: JiraStatus;
      issuetype?: JiraIssueType;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  /** Custom fields and any other fields not listed above */
  [key: string]: unknown;
}

/**
 * Top-level Jira issue object returned by GET /rest/api/3/issue/{key}.
 * Used by jira.getIssue() in lib/jira.js.
 */
export interface JiraIssue {
  /** Issue ID (numeric string) */
  id: string;
  /** Issue key (e.g., "AUT-8031") */
  key: string;
  /** Self URL */
  self: string;
  /** All issue fields */
  fields: JiraFields;
  /** Changelog (only present if expanded) */
  changelog?: {
    startAt: number;
    maxResults: number;
    total: number;
    histories: readonly JiraChangelog[];
  };
  [key: string]: unknown;
}

/**
 * Jira search result from POST /rest/api/3/search.
 */
export interface JiraSearchResult {
  /** Starting index of results */
  startAt: number;
  /** Maximum results per page */
  maxResults: number;
  /** Total number of matching issues */
  total: number;
  /** Array of matching issues */
  issues: readonly JiraIssue[];
  [key: string]: unknown;
}
