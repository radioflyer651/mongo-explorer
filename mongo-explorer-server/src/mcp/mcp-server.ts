import { randomUUID } from 'crypto';
import { injectable } from 'inversify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Request, Response } from 'express';
import { McpToolContext } from './mcp-tool-context';
import { registerReadTools } from './tools/read-tools';
import { registerUiTools } from './tools/ui-tools';
import { registerPipelineAndShellTools } from './tools/pipeline-shell-tools';
import { registerProposalTools } from './tools/proposal-tools';
import { toObjectId } from './mcp-tool-context';
import { errorMessage } from '../utils/misc.util';

/**
 * Tool names that must never exist. Asserted at start-up, so an accidental
 * registration fails loudly rather than shipping.
 *
 * apply_proposal is the important one: the user applies proposals from the Proposals
 * panel, and no AI-reachable path may execute a Target Database write.
 */
export const PROHIBITED_TOOL_NAMES: readonly string[] = [
    'apply_proposal',
    'update_documents',
    'delete_documents',
    'insert_documents',
    'replace_document',
    'drop_collection',
    'drop_database',
    'create_collection',
    'rename_collection',
    'create_index',
    'drop_index',
    'execute_shell',
    'run_pipeline',
    'run_pipeline_with_out',
    'kill_operation',
    'set_mcp_mode',
    'set_connection_read_only',
    'get_connection_credentials',
    'save_connection',
    'delete_connection',
];

/**
 * Hosts the Model Context Protocol server inside the Express application.
 *
 * A module rather than a sidecar: for a single-user local application this shares the
 * container, the connection manager, live connections, and the proposal store
 * directly — no inter-process plumbing and no duplicated authentication.
 */
@injectable()
export class McpServerHost {
    constructor(context: McpToolContext) {
        this.context = context;
    }

    private readonly context: McpToolContext;

    /** One server and transport per client session, keyed by session id. */
    private readonly sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; }>();

    /** Tool names, captured once at start-up for diagnostics and the assertion. */
    private toolNames: string[] = [];

    /** Builds a throwaway server to assert the tool surface before serving traffic. */
    async initialize(): Promise<void> {
        const probe = this.createServer();
        this.toolNames = readToolNames(probe);
        this.assertNoProhibitedTools(this.toolNames);
        await probe.close();
    }

    /** Builds a fully registered server instance. */
    private createServer(): McpServer {
        const server = new McpServer(
            { name: 'mongo-explorer', version: '0.1.0' },
            {
                instructions:
                    'Mongo Explorer is a MongoDB client. You may read Target Databases freely, change what ' +
                    'the user is looking at when the AI mode switch is set to Collaborate, and stage data ' +
                    'changes as proposals.\n\n' +
                    'You cannot write to a Target Database. There is no tool that does, and no mode that ' +
                    'permits it. Use the propose_* tools; the user reviews a diff and executes it. Do not ' +
                    'look for another route.\n\n' +
                    'Start with get_app_state to see what the user is looking at. Pass its revision to ' +
                    'mutating tools so you do not act on a stale view. Filters, sorts, documents, and ' +
                    'pipeline stages are all Extended JSON strings — plain JSON loses BSON types. Note that ' +
                    'null and an absent field are different things in MongoDB, and a Target Database _id may ' +
                    'be any BSON type, not necessarily an ObjectId.',
            }
        );

        registerReadTools(server, this.context);
        registerUiTools(server, this.context);
        registerPipelineAndShellTools(server, this.context);
        registerProposalTools(server, this.context);
        this.registerResources(server);

        return server;
    }

    /**
     * Handles an MCP HTTP request.
     *
     * A session is created on the initialize request and reused thereafter, which is
     * what lets the server push resource-update notifications when the user changes
     * something rather than making the client poll.
     */
    async handleRequest(req: Request, res: Response): Promise<void> {
        try {
            const sessionId = readSessionId(req);

            if (sessionId) {
                const existing = this.sessions.get(sessionId);

                if (!existing) {
                    res.status(404).json({ message: 'Unknown MCP session. Send an initialize request to start a new one.' });
                    return;
                }

                await existing.transport.handleRequest(req, res, req.body);
                return;
            }

            if (!isInitializeRequest(req.body)) {
                res.status(400).json({
                    message: 'The first MCP request must be an initialize request.',
                });
                return;
            }

            await this.openSession(req, res);
        } catch (error) {
            if (!res.headersSent) {
                res.status(500).json({ message: errorMessage(error) });
            }
        }
    }

    /** Creates a session, connects a fresh server, and serves the initialize call. */
    private async openSession(req: Request, res: Response): Promise<void> {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: sessionId => {
                this.sessions.set(sessionId, { server, transport });
            },
        });

        const server = this.createServer();

        transport.onclose = () => {
            const sessionId = transport.sessionId;

            if (sessionId) {
                this.sessions.delete(sessionId);
            }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }

    /** Closes every open session. */
    async close(): Promise<void> {
        for (const session of [...this.sessions.values()]) {
            await session.transport.close();
            await session.server.close();
        }

        this.sessions.clear();
    }

    /** How many client sessions are currently open. */
    get openSessionCount(): number {
        return this.sessions.size;
    }

    /** Registers the readable resources that describe application state. */
    private registerResources(server: McpServer): void {
        const json = (uri: string, value: unknown) => ({
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, undefined, 2) }],
        });

        server.registerResource(
            'app-state',
            'mongo-explorer://app/state',
            {
                title: 'Application state',
                description: 'What the user is currently looking at, including a revision number.',
                mimeType: 'application/json',
            },
            async uri => json(uri.href, this.context.sessionService.getState())
        );

        server.registerResource(
            'app-mode',
            'mongo-explorer://app/mode',
            {
                title: 'AI permission mode',
                description: 'The current AI mode and what it permits. Readable in every mode.',
                mimeType: 'application/json',
            },
            async uri =>
                json(uri.href, {
                    mode: this.context.modeService.currentMode,
                    capabilities: this.context.modeService.capabilities,
                })
        );

        server.registerResource(
            'connections',
            'mongo-explorer://connections',
            {
                title: 'Saved connections',
                description: 'Saved connections, redacted. Never contains credentials.',
                mimeType: 'application/json',
            },
            async uri => json(uri.href, await this.context.savedConnections.getConnectionListings())
        );

        server.registerResource(
            'proposals',
            'mongo-explorer://proposals',
            {
                title: 'Pending proposals',
                description: 'Data changes awaiting the user\'s decision.',
                mimeType: 'application/json',
            },
            async uri => json(uri.href, this.context.proposalService.getAll())
        );

        server.registerResource(
            'shell-transcript',
            'mongo-explorer://shell/transcript',
            {
                title: 'Shell transcript',
                description: 'Shell history and results.',
                mimeType: 'application/json',
            },
            async uri => json(uri.href, this.context.shellService.getTranscript())
        );

        server.registerResource(
            'activity',
            'mongo-explorer://activity',
            {
                title: 'Activity log',
                description: 'Recent changes with actor attribution — who changed what.',
                mimeType: 'application/json',
            },
            async uri => json(uri.href, this.context.activityService.getRecent(100))
        );

        server.registerResource(
            'pipeline',
            'mongo-explorer://pipeline/current',
            {
                title: 'Current pipeline',
                description: 'The aggregation builder state, stage by stage.',
                mimeType: 'application/json',
            },
            async uri => json(uri.href, this.context.sessionService.getState().pipeline ?? null)
        );

        server.registerResource(
            'current-view',
            'mongo-explorer://view/current',
            {
                title: 'Current view',
                description: 'The collection view on screen, including its filter and page position.',
                mimeType: 'application/json',
            },
            async uri => json(uri.href, this.context.sessionService.getState().currentView ?? null)
        );
    }

    /**
     * Fails start-up when a prohibited tool has been registered. The guarantee that
     * an AI cannot write is worth asserting mechanically rather than trusting to
     * review.
     */
    private assertNoProhibitedTools(registered: readonly string[]): void {
        const offending = registered.filter(name => PROHIBITED_TOOL_NAMES.includes(name));

        if (offending.length) {
            throw new Error(
                `Prohibited MCP tool${offending.length > 1 ? 's' : ''} registered: ${offending.join(', ')}. ` +
                'AI-originated Target Database writes are structurally prohibited. See ' +
                'workspace/mcp-server-spec.md, Red lines.'
            );
        }
    }

    /** The registered tool names, for diagnostics and tests. */
    getRegisteredToolNames(): string[] {
        return [...this.toolNames];
    }
}

/** Reads the registered tool names from a server instance. */
function readToolNames(server: McpServer): string[] {
    return Object.keys((server as unknown as { _registeredTools?: Record<string, unknown>; })._registeredTools ?? {});
}

/** Reads the MCP session identifier header, when present. */
function readSessionId(req: Request): string | undefined {
    const header = req.headers['mcp-session-id'];
    const value = Array.isArray(header) ? header[0] : header;
    return value && value.length ? value : undefined;
}

/** Re-exported so route handlers can convert identifiers consistently. */
export { toObjectId };
