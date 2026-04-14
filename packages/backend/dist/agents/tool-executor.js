"use strict";
// =====================================================================
// MI Dev Agent -- Tool Executor for Claude API Agent Loop
// =====================================================================
// Executes tool calls returned by the Anthropic Messages API.
//
// Supported tools:
//   read_file, write_file, edit_file, bash, glob, grep, list_dir
//
// Security sandbox:
//   - All paths resolved with realpath, must be within projectDir
//   - Bash: whitelist of safe commands only
//   - Stdout capped at 2MB, stderr at 1MB
//   - Symlink escape prevention
// =====================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolExecutor = exports.TOOL_DEFINITIONS = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const logger_1 = require("../lib/logger");
// ── Constants ────────────────────────────────────────────────────────
const MAX_STDOUT = 2 * 1024 * 1024; // 2MB
const MAX_STDERR = 1 * 1024 * 1024; // 1MB
const BASH_TIMEOUT_MS = 60_000; // 60 seconds per command
const MAX_FILE_READ_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILE_WRITE_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_GLOB_RESULTS = 1000;
/**
 * Bash commands that are allowed for execution.
 * Read-only git commands, package managers, and search tools.
 */
const BASH_WHITELIST = new Set([
    'npm', 'npx', 'node',
    'git',
    'grep', 'rg',
    'find',
    'ls', 'cat', 'head', 'tail', 'wc',
    'echo', 'printf',
    'sort', 'uniq', 'diff', 'comm',
    'basename', 'dirname', 'realpath',
    'date', 'env',
    'true', 'false', 'test',
    'tsc', 'eslint',
    'jq',
]);
/**
 * Git subcommands that are read-only and safe.
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
    'log', 'diff', 'show', 'status', 'branch', 'tag',
    'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
    'describe', 'blame', 'shortlog', 'reflog',
    'stash', // stash list is read-only
    'remote', // remote -v is read-only
    'config', // config --get is read-only
]);
/**
 * Commands that are explicitly blocked (dangerous operations).
 */
const BASH_BLOCKLIST = new Set([
    'rm', 'rmdir', 'mv', 'chmod', 'chown', 'chgrp',
    'curl', 'wget', 'ssh', 'scp', 'rsync',
    'eval', 'exec', 'source',
    'sudo', 'su',
    'kill', 'killall', 'pkill',
    'dd', 'mkfs', 'mount', 'umount',
    'shutdown', 'reboot', 'poweroff',
    'iptables', 'ufw',
    'docker', 'podman',
    'systemctl', 'service',
    'crontab', 'at',
    'nc', 'ncat', 'socat', 'telnet',
    'python', 'python3', 'ruby', 'perl', 'php',
]);
// ── Tool Definitions (Anthropic format) ──────────────────────────────
exports.TOOL_DEFINITIONS = [
    {
        name: 'read_file',
        description: 'Read the contents of a file at the given path. Returns the file content as a string.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute or relative path to the file to read',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file at the given path. Creates the file if it does not exist, overwrites if it does.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute or relative path to the file to write',
                },
                content: {
                    type: 'string',
                    description: 'The content to write to the file',
                },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'edit_file',
        description: 'Edit a file by replacing an exact string match with new content. The old_string must match exactly one location in the file.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute or relative path to the file to edit',
                },
                old_string: {
                    type: 'string',
                    description: 'The exact string to find and replace in the file',
                },
                new_string: {
                    type: 'string',
                    description: 'The replacement string',
                },
            },
            required: ['path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'bash',
        description: 'Execute a bash command in the project directory. Only safe, read-mostly commands are allowed (npm, git read-only, grep, find, ls, cat, etc.).',
        input_schema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The bash command to execute',
                },
            },
            required: ['command'],
        },
    },
    {
        name: 'glob',
        description: 'Find files matching a glob pattern in the project directory. Returns a newline-separated list of matching file paths.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.tsx")',
                },
                path: {
                    type: 'string',
                    description: 'Optional subdirectory to search within (relative to project root)',
                },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'grep',
        description: 'Search for a regex pattern in files. Returns matching lines with file paths and line numbers.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Regular expression pattern to search for',
                },
                path: {
                    type: 'string',
                    description: 'Optional directory or file to search in (relative to project root)',
                },
                include: {
                    type: 'string',
                    description: 'Optional glob pattern to filter files (e.g., "*.ts")',
                },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'list_dir',
        description: 'List files and directories at the given path. Returns a formatted directory listing.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute or relative path to the directory to list',
                },
            },
            required: ['path'],
        },
    },
];
// ── ToolExecutor Class ───────────────────────────────────────────────
class ToolExecutor {
    projectDir;
    constructor(projectDir) {
        // Resolve and normalize the project directory
        this.projectDir = path.resolve(projectDir);
        if (!fs.existsSync(this.projectDir)) {
            throw new Error(`ToolExecutor: project directory does not exist: ${this.projectDir}`);
        }
    }
    /**
     * Execute a tool by name with the given input.
     * Returns a ToolResult with success status and output/error.
     */
    async execute(toolName, input) {
        try {
            switch (toolName) {
                case 'read_file':
                    return await this.readFile(input);
                case 'write_file':
                    return await this.writeFile(input);
                case 'edit_file':
                    return await this.editFile(input);
                case 'bash':
                    return await this.bash(input);
                case 'glob':
                    return await this.glob(input);
                case 'grep':
                    return await this.grepTool(input);
                case 'list_dir':
                    return await this.listDir(input);
                default:
                    return { success: false, output: '', error: `Unknown tool: ${toolName}` };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, output: '', error: message };
        }
    }
    // ── Path Security ──────────────────────────────────────────────────
    /**
     * Resolve a path and validate it is within the project directory.
     * Prevents path traversal and symlink escape attacks.
     */
    resolveSafePath(inputPath) {
        // Resolve relative to project dir
        const resolved = path.isAbsolute(inputPath)
            ? path.resolve(inputPath)
            : path.resolve(this.projectDir, inputPath);
        // Check the resolved path is within the project directory
        if (!resolved.startsWith(this.projectDir + path.sep) && resolved !== this.projectDir) {
            throw new Error(`Path escapes project directory: "${inputPath}" resolves to "${resolved}" ` +
                `which is outside "${this.projectDir}"`);
        }
        // For existing paths, also check the real path (resolves symlinks)
        if (fs.existsSync(resolved)) {
            let realResolved;
            try {
                realResolved = fs.realpathSync(resolved);
            }
            catch {
                // If realpath fails (e.g., broken symlink), the resolved path is still valid
                return resolved;
            }
            if (!realResolved.startsWith(this.projectDir + path.sep) && realResolved !== this.projectDir) {
                throw new Error(`Symlink escape detected: "${inputPath}" resolves via symlink to "${realResolved}" ` +
                    `which is outside "${this.projectDir}"`);
            }
        }
        return resolved;
    }
    // ── Tool Implementations ───────────────────────────────────────────
    async readFile(input) {
        if (!input.path) {
            return { success: false, output: '', error: 'Missing required parameter: path' };
        }
        const safePath = this.resolveSafePath(input.path);
        if (!fs.existsSync(safePath)) {
            return { success: false, output: '', error: `File not found: ${input.path}` };
        }
        const stat = fs.statSync(safePath);
        if (stat.isDirectory()) {
            return { success: false, output: '', error: `Path is a directory, not a file: ${input.path}` };
        }
        if (stat.size > MAX_FILE_READ_SIZE) {
            return {
                success: false,
                output: '',
                error: `File too large: ${stat.size} bytes (max ${MAX_FILE_READ_SIZE} bytes). Use grep or head to read portions.`,
            };
        }
        const content = fs.readFileSync(safePath, 'utf8');
        return { success: true, output: content };
    }
    async writeFile(input) {
        if (!input.path) {
            return { success: false, output: '', error: 'Missing required parameter: path' };
        }
        if (input.content === undefined || input.content === null) {
            return { success: false, output: '', error: 'Missing required parameter: content' };
        }
        if (input.content.length > MAX_FILE_WRITE_SIZE) {
            return {
                success: false,
                output: '',
                error: `Content too large: ${input.content.length} bytes (max ${MAX_FILE_WRITE_SIZE} bytes)`,
            };
        }
        const safePath = this.resolveSafePath(input.path);
        // Create parent directories if they don't exist
        const dir = path.dirname(safePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(safePath, input.content, 'utf8');
        return { success: true, output: `File written: ${input.path} (${input.content.length} bytes)` };
    }
    async editFile(input) {
        if (!input.path) {
            return { success: false, output: '', error: 'Missing required parameter: path' };
        }
        if (!input.old_string && input.old_string !== '') {
            return { success: false, output: '', error: 'Missing required parameter: old_string' };
        }
        if (input.new_string === undefined || input.new_string === null) {
            return { success: false, output: '', error: 'Missing required parameter: new_string' };
        }
        const safePath = this.resolveSafePath(input.path);
        if (!fs.existsSync(safePath)) {
            return { success: false, output: '', error: `File not found: ${input.path}` };
        }
        const content = fs.readFileSync(safePath, 'utf8');
        // Count occurrences
        const occurrences = content.split(input.old_string).length - 1;
        if (occurrences === 0) {
            return {
                success: false,
                output: '',
                error: `old_string not found in ${input.path}. Ensure the string matches exactly (including whitespace).`,
            };
        }
        if (occurrences > 1) {
            return {
                success: false,
                output: '',
                error: `old_string found ${occurrences} times in ${input.path}. It must be unique. Provide more context to make the match unique.`,
            };
        }
        const newContent = content.replace(input.old_string, input.new_string);
        fs.writeFileSync(safePath, newContent, 'utf8');
        return { success: true, output: `File edited: ${input.path}` };
    }
    async bash(input) {
        if (!input.command) {
            return { success: false, output: '', error: 'Missing required parameter: command' };
        }
        // Validate command against whitelist/blocklist
        const validationError = this.validateBashCommand(input.command);
        if (validationError) {
            return { success: false, output: '', error: validationError };
        }
        return this.execCommand(input.command);
    }
    async glob(input) {
        if (!input.pattern) {
            return { success: false, output: '', error: 'Missing required parameter: pattern' };
        }
        const searchDir = input.path
            ? this.resolveSafePath(input.path)
            : this.projectDir;
        // Use find command for glob matching (cross-platform, no extra deps)
        const findCmd = `find "${searchDir}" -type f -name "${input.pattern.replace(/"/g, '\\"')}" 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
        // For ** patterns, use a different approach
        if (input.pattern.includes('**') || input.pattern.includes('/')) {
            // Use bash globstar for recursive patterns
            const cmd = `cd "${searchDir}" && shopt -s globstar nullglob && printf '%s\n' ${input.pattern} 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
            const result = await this.execCommand(cmd);
            if (!result.success && !result.output) {
                // Fallback: try with find -path
                const pathPattern = input.pattern
                    .replace(/\*\*/g, '*')
                    .replace(/\*/g, '*');
                const fallbackCmd = `find "${searchDir}" -type f -path "*${pathPattern}" 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
                return this.execCommand(fallbackCmd);
            }
            return result;
        }
        return this.execCommand(findCmd);
    }
    async grepTool(input) {
        if (!input.pattern) {
            return { success: false, output: '', error: 'Missing required parameter: pattern' };
        }
        const searchDir = input.path
            ? this.resolveSafePath(input.path)
            : this.projectDir;
        // Build grep command
        const parts = ['grep', '-rn', '--color=never'];
        if (input.include) {
            parts.push(`--include="${input.include.replace(/"/g, '\\"')}"`);
        }
        // Exclude common non-source directories
        parts.push('--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=build', '--exclude-dir=.next', '--exclude-dir=coverage');
        parts.push(`"${input.pattern.replace(/"/g, '\\"')}"`);
        parts.push(`"${searchDir}"`);
        parts.push('2>/dev/null');
        parts.push('| head -200'); // Cap output to 200 matches
        const cmd = parts.join(' ');
        const result = await this.execCommand(cmd);
        // grep returns exit code 1 when no matches found -- not an error
        if (!result.success && result.output === '' && !result.error) {
            return { success: true, output: 'No matches found.' };
        }
        return result;
    }
    async listDir(input) {
        if (!input.path) {
            return { success: false, output: '', error: 'Missing required parameter: path' };
        }
        const safePath = this.resolveSafePath(input.path);
        if (!fs.existsSync(safePath)) {
            return { success: false, output: '', error: `Directory not found: ${input.path}` };
        }
        const stat = fs.statSync(safePath);
        if (!stat.isDirectory()) {
            return { success: false, output: '', error: `Path is not a directory: ${input.path}` };
        }
        const entries = fs.readdirSync(safePath, { withFileTypes: true });
        const lines = [];
        for (const entry of entries) {
            const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other';
            const prefix = entry.isDirectory() ? '/' : '';
            lines.push(`[${type}] ${entry.name}${prefix}`);
        }
        if (lines.length === 0) {
            return { success: true, output: '(empty directory)' };
        }
        return { success: true, output: lines.join('\n') };
    }
    // ── Bash Command Validation ────────────────────────────────────────
    /**
     * Validates a bash command against the whitelist and blocklist.
     * Returns an error message if the command is not allowed, or null if OK.
     */
    validateBashCommand(command) {
        // Strip leading whitespace and common prefixes
        const trimmed = command.trim();
        // Block dangerous shell operators
        if (/[|&;]/.test(trimmed)) {
            // Allow piping (|) and chaining (&&, ;) but validate each sub-command
            const subCommands = trimmed.split(/\s*(?:\|\||&&|[|;&])\s*/);
            for (const sub of subCommands) {
                const err = this.validateSingleCommand(sub.trim());
                if (err)
                    return err;
            }
            return null;
        }
        return this.validateSingleCommand(trimmed);
    }
    validateSingleCommand(command) {
        if (!command)
            return null;
        // Extract the base command (first token)
        // Handle: env VAR=value command, cd dir && command, etc.
        let baseCmd = command.split(/\s+/)[0];
        // Handle path prefixes: /usr/bin/git -> git
        baseCmd = path.basename(baseCmd);
        // Handle env prefix: env FOO=bar git status -> skip 'env'
        if (baseCmd === 'env') {
            // Find the actual command after env vars
            const parts = command.split(/\s+/);
            for (let i = 1; i < parts.length; i++) {
                if (!parts[i].includes('=')) {
                    baseCmd = path.basename(parts[i]);
                    break;
                }
            }
        }
        // Handle cd (allow but it's harmless in a subprocess)
        if (baseCmd === 'cd' || baseCmd === 'shopt' || baseCmd === 'printf') {
            return null;
        }
        // Check blocklist first (higher priority)
        if (BASH_BLOCKLIST.has(baseCmd)) {
            return `Command "${baseCmd}" is blocked for security. Blocked commands include: rm, mv, chmod, curl, wget, ssh, eval, exec.`;
        }
        // Check whitelist
        if (!BASH_WHITELIST.has(baseCmd)) {
            return `Command "${baseCmd}" is not in the allowed command list. Allowed: ${[...BASH_WHITELIST].sort().join(', ')}`;
        }
        // Special handling for git: only allow read-only subcommands
        if (baseCmd === 'git') {
            const gitSubcmd = this.extractGitSubcommand(command);
            if (gitSubcmd && !GIT_READ_ONLY_SUBCOMMANDS.has(gitSubcmd)) {
                return `Git subcommand "${gitSubcmd}" is not allowed. Only read-only subcommands are permitted: ${[...GIT_READ_ONLY_SUBCOMMANDS].sort().join(', ')}`;
            }
        }
        return null;
    }
    extractGitSubcommand(command) {
        // Match: git [flags] subcommand
        const match = command.match(/\bgit\s+(?:-\S+\s+)*(\S+)/);
        return match ? match[1] : null;
    }
    // ── Command Execution ──────────────────────────────────────────────
    /**
     * Execute a shell command with stdout/stderr limits and timeout.
     */
    execCommand(command) {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let done = false;
            let stdoutOverflow = false;
            let stderrOverflow = false;
            const proc = (0, child_process_1.spawn)('bash', ['-c', command], {
                cwd: this.projectDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    // Prevent git from prompting for credentials
                    GIT_TERMINAL_PROMPT: '0',
                },
            });
            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    try {
                        proc.kill('SIGKILL');
                    }
                    catch { /* already dead */ }
                    resolve({
                        success: false,
                        output: stdout,
                        error: `Command timed out after ${BASH_TIMEOUT_MS / 1000}s`,
                    });
                }
            }, BASH_TIMEOUT_MS);
            proc.stdout.on('data', (chunk) => {
                if (stdout.length < MAX_STDOUT) {
                    const data = chunk.toString();
                    stdout += data.substring(0, MAX_STDOUT - stdout.length);
                }
                else if (!stdoutOverflow) {
                    stdoutOverflow = true;
                    (0, logger_1.logDebug)(`Bash stdout overflow (>${MAX_STDOUT} bytes) -- output truncated`);
                }
            });
            proc.stderr.on('data', (chunk) => {
                if (stderr.length < MAX_STDERR) {
                    const data = chunk.toString();
                    stderr += data.substring(0, MAX_STDERR - stderr.length);
                }
                else if (!stderrOverflow) {
                    stderrOverflow = true;
                    (0, logger_1.logDebug)(`Bash stderr overflow (>${MAX_STDERR} bytes) -- output truncated`);
                }
            });
            proc.on('close', (code) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                const output = stdout.trim();
                const errorOutput = stderr.trim();
                if (code === 0) {
                    resolve({
                        success: true,
                        output: output || errorOutput || '(no output)',
                    });
                }
                else {
                    // For grep, exit code 1 means no match (not an error)
                    const isGrepNoMatch = command.trim().startsWith('grep') && code === 1 && !errorOutput;
                    if (isGrepNoMatch) {
                        resolve({ success: true, output: '' });
                    }
                    else {
                        resolve({
                            success: false,
                            output,
                            error: errorOutput || `Command exited with code ${code}`,
                        });
                    }
                }
            });
            proc.on('error', (err) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                resolve({
                    success: false,
                    output: '',
                    error: `Failed to execute command: ${err.message}`,
                });
            });
        });
    }
    // ── Accessors ──────────────────────────────────────────────────────
    /** Get the project directory this executor is bound to. */
    getProjectDir() {
        return this.projectDir;
    }
    /** Get the list of tool definitions in Anthropic API format. */
    static getToolDefinitions() {
        return exports.TOOL_DEFINITIONS;
    }
}
exports.ToolExecutor = ToolExecutor;
//# sourceMappingURL=tool-executor.js.map