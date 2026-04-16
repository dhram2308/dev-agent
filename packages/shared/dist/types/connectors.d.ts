/**
 * Configuration for the Google Drive connector.
 */
export interface GDriveConfig {
    /** GCP Service Account JSON (raw or base64-encoded) */
    serviceAccountJson: string;
    /** Per-item content budget in bytes */
    connectorBudget?: number;
}
/**
 * Result of a Google Drive fetch operation.
 */
export interface GDriveResult {
    /** Whether the operation succeeded */
    ok: boolean;
    /** Document or sheet title */
    title?: string;
    /** Fetched content (markdown for docs, CSV for sheets) */
    content?: string;
    /** Error message on failure */
    error?: string;
}
/**
 * Matched Google Drive URL components.
 */
export interface GDriveUrlMatch {
    /** Type of Google Drive resource */
    type: 'doc' | 'sheet' | 'file';
    /** Google Drive file ID */
    fileId: string;
    /** Sheet tab GID (for spreadsheets) */
    gid?: string;
}
/**
 * Configuration for the Figma connector.
 */
export interface FigmaConfig {
    /** Figma Personal Access Token */
    token: string;
    /** Maximum tree traversal depth */
    maxDepth?: number;
    /** Maximum nodes to process */
    maxNodes?: number;
}
/**
 * Result of a Figma file fetch operation.
 */
export interface FigmaResult {
    /** Whether the operation succeeded */
    ok: boolean;
    /** File title from Figma */
    title?: string;
    /** Extracted content (structured markdown) */
    content?: string;
    /** Figma file key */
    fileKey?: string;
    /** Top-level frame IDs for optional vision export */
    frameIds?: string[];
    /** Error message on failure */
    error?: string;
}
/**
 * A node extracted from the Figma file tree.
 */
export interface FigmaNode {
    /** Node type (TEXT, FRAME, COMPONENT, COMPONENT_SET, CANVAS, etc.) */
    type: string;
    /** Node name in Figma */
    name: string;
    /** Text characters (for TEXT nodes) */
    characters?: string;
    /** Parent frame name (for context) */
    frame?: string;
    /** Child nodes */
    children?: FigmaNode[];
    /** Node ID (for image export) */
    id?: string;
}
/**
 * Matched Figma URL components.
 */
export interface FigmaUrlMatch {
    /** Figma file key */
    fileKey: string;
    /** Specific node ID from URL query params */
    nodeId?: string;
}
/**
 * Configuration for the Postman connector.
 */
export interface PostmanConfig {
    /** Postman API key */
    apiKey: string;
    /** Per-item content budget in bytes */
    connectorBudget?: number;
}
/**
 * Result of a Postman collection fetch operation.
 */
export interface PostmanResult {
    /** Whether the operation succeeded */
    ok: boolean;
    /** Collection title */
    title?: string;
    /** Flattened endpoint summary */
    content?: string;
    /** Error message on failure */
    error?: string;
}
/**
 * A single request extracted from a Postman collection.
 */
export interface PostmanRequest {
    /** Folder/group name within the collection */
    folder: string;
    /** HTTP method (GET, POST, PUT, DELETE, etc.) */
    method: string;
    /** Request URL path */
    path: string;
    /** Request name */
    name: string;
    /** Request description (truncated) */
    desc: string;
    /** Extracted body schema (key: type pairs) */
    bodySchema: string;
}
/**
 * A Postman collection structure.
 */
export interface PostmanCollection {
    /** Collection info metadata */
    info: {
        /** Collection name */
        name?: string;
        /** Collection description */
        description?: string | {
            content: string;
        };
        /** Postman-internal ID */
        _postman_id?: string;
        /** Collection schema URL */
        schema?: string;
    };
    /** Collection-level variables */
    variable?: Array<{
        key: string;
        value: string;
    }>;
    /** Collection items (folders and requests) */
    item?: unknown[];
}
/**
 * Matched Postman URL components.
 */
export interface PostmanUrlMatch {
    /** Postman collection ID */
    collectionId: string;
}
/**
 * Result of a connector test/health-check operation.
 */
export interface ConnectorTestResult {
    /** Whether the connection test passed */
    ok: boolean;
    /** Success message with connection details */
    message?: string;
    /** Error message on failure */
    error?: string;
}
//# sourceMappingURL=connectors.d.ts.map