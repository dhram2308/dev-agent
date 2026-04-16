/**
 * All known ADF node types handled by adfToMarkdown() in lib/adf.js.
 */
export type AdfNodeType = 'doc' | 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'listItem' | 'blockquote' | 'codeBlock' | 'rule' | 'panel' | 'expand' | 'nestedExpand' | 'table' | 'tableRow' | 'tableHeader' | 'tableCell' | 'mediaSingle' | 'mediaGroup' | 'media' | 'taskList' | 'taskItem' | 'decisionList' | 'decisionItem' | 'layoutSection' | 'layoutColumn' | 'text' | 'hardBreak' | 'inlineCard' | 'mention' | 'emoji' | 'date' | 'status' | 'placeholder' | 'extension' | 'bodiedExtension' | 'inlineExtension';
/**
 * All known ADF mark types applied to text nodes.
 */
export type AdfMarkType = 'strong' | 'em' | 'code' | 'strike' | 'link' | 'underline' | 'textColor' | 'subsup';
/** ADF mark (formatting applied to text nodes) */
export interface AdfMark {
    /** Mark type */
    type: AdfMarkType;
    /** Mark attributes (e.g., href for links, color for textColor) */
    attrs?: AdfMarkAttrs;
}
/** Generic mark attributes */
export interface AdfMarkAttrs {
    /** Link href (for "link" marks) */
    href?: string;
    /** Text color hex value (for "textColor" marks) */
    color?: string;
    /** Sub/superscript type (for "subsup" marks) */
    type?: 'sub' | 'sup';
    [key: string]: unknown;
}
/** Attributes for heading nodes */
export interface AdfHeadingAttrs {
    /** Heading level (1-6) */
    level: number;
}
/** Attributes for codeBlock nodes */
export interface AdfCodeBlockAttrs {
    /** Programming language for syntax highlighting */
    language?: string;
}
/** Attributes for mention nodes */
export interface AdfMentionAttrs {
    /** Atlassian account ID */
    id?: string;
    /** Display text for the mention */
    text?: string;
    /** Access level */
    accessLevel?: string;
    /** User type */
    userType?: string;
}
/** Attributes for inlineCard (Smart Link) nodes */
export interface AdfInlineCardAttrs {
    /** URL of the linked resource */
    url: string;
    /** Additional data (optional) */
    data?: Record<string, unknown>;
}
/** Attributes for media nodes */
export interface AdfMediaAttrs {
    /** Media ID in Jira/Confluence */
    id?: string;
    /** Media type ("file", "link", "external") */
    type?: string;
    /** Collection (e.g., issue attachment collection) */
    collection?: string;
    /** Alt text */
    alt?: string;
    /** Direct URL (for external media) */
    url?: string;
    /** Width */
    width?: number;
    /** Height */
    height?: number;
    [key: string]: unknown;
}
/** Attributes for tableCell / tableHeader nodes */
export interface AdfTableCellAttrs {
    /** Column span */
    colspan?: number;
    /** Row span */
    rowspan?: number;
    /** Background color */
    background?: string;
    /** Column widths (for table layout) */
    colwidth?: readonly number[];
    [key: string]: unknown;
}
/** Attributes for panel nodes */
export interface AdfPanelAttrs {
    /** Panel type: "info", "note", "warning", "error", "success" */
    panelType: string;
}
/** Attributes for expand / nestedExpand nodes */
export interface AdfExpandAttrs {
    /** Expand section title */
    title?: string;
}
/** Attributes for taskItem nodes */
export interface AdfTaskItemAttrs {
    /** Local ID for the task */
    localId?: string;
    /** Task completion state */
    state?: 'TODO' | 'DONE';
}
/** Attributes for decisionItem nodes */
export interface AdfDecisionItemAttrs {
    /** Local ID for the decision */
    localId?: string;
    /** Decision state */
    state?: 'DECIDED' | string;
}
/** Attributes for emoji nodes */
export interface AdfEmojiAttrs {
    /** Short name (e.g., ":smile:") */
    shortName?: string;
    /** Emoji ID */
    id?: string;
    /** Emoji text */
    text?: string;
}
/** Attributes for date nodes */
export interface AdfDateAttrs {
    /** Timestamp in milliseconds (stored as string) */
    timestamp: string;
}
/** Attributes for status nodes */
export interface AdfStatusAttrs {
    /** Status text */
    text: string;
    /** Status color */
    color?: string;
    /** Local ID */
    localId?: string;
    /** Style */
    style?: string;
}
/** Attributes for extension / bodiedExtension / inlineExtension nodes */
export interface AdfExtensionAttrs {
    /** Extension key */
    extensionKey?: string;
    /** Extension title */
    extensionTitle?: string;
    /** Extension type */
    extensionType?: string;
    /** Layout */
    layout?: string;
    /** Extension parameters */
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
}
/** Attributes for placeholder nodes */
export interface AdfPlaceholderAttrs {
    /** Placeholder text */
    text?: string;
}
/**
 * Union of all possible ADF node attribute types.
 * The actual attrs shape depends on the node type.
 */
export type AdfAttrs = AdfHeadingAttrs | AdfCodeBlockAttrs | AdfMentionAttrs | AdfInlineCardAttrs | AdfMediaAttrs | AdfTableCellAttrs | AdfPanelAttrs | AdfExpandAttrs | AdfTaskItemAttrs | AdfDecisionItemAttrs | AdfEmojiAttrs | AdfDateAttrs | AdfStatusAttrs | AdfExtensionAttrs | AdfPlaceholderAttrs | Record<string, unknown>;
/**
 * Recursive ADF node — the core building block of Atlassian Document Format.
 *
 * Every ADF document is a tree of AdfNode objects. The root node has type "doc"
 * and version 1. Child nodes are stored in the `content` array.
 */
export interface AdfNode {
    /** Node type (see AdfNodeType for all known values) */
    type: AdfNodeType | string;
    /** ADF version (only present on root "doc" nodes) */
    version?: number;
    /** Child nodes (recursive) */
    content?: AdfNode[];
    /** Text content (only present on "text" nodes) */
    text?: string;
    /** Formatting marks applied to this node (text nodes only) */
    marks?: AdfMark[];
    /** Node-specific attributes */
    attrs?: AdfAttrs;
    [key: string]: unknown;
}
//# sourceMappingURL=adf.d.ts.map