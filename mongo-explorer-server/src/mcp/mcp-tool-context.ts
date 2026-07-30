import { ObjectId } from 'mongodb';
import { ZodTypeAny } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpModeService } from './mcp-mode.service';
import { AppSessionService } from './app-session.service';
import { ProposalService } from './proposal.service';
import { ActivityService } from './activity.service';
import { ConnectionManager } from '../connections/connection-manager.service';
import { LiveConnection } from '../connections/live-connection';
import { DatabaseExplorerService } from '../explorer/database-explorer.service';
import { QueryService } from '../explorer/query.service';
import { IndexAdminService } from '../explorer/index-admin.service';
import { PipelineService } from '../explorer/pipeline.service';
import { ShellService } from '../explorer/shell.service';
import { ServerStatusService } from '../explorer/server-status.service';
import { SavedConnectionDbService } from '../database/saved-connection-db.service';
import { SavedPipelineDbService } from '../database/saved-pipeline-db.service';
import { McpRefusal } from '../model/shared-models/mcp/mcp-mode.model';
import { DirtySurface } from '../model/shared-models/mcp/app-session-state.model';
import { errorMessage } from '../utils/misc.util';
import { redactText } from '../utils/redaction.util';

/** Everything the MCP tool registrations need. */
export interface McpToolContext {
    modeService: McpModeService;
    sessionService: AppSessionService;
    proposalService: ProposalService;
    activityService: ActivityService;
    connectionManager: ConnectionManager;
    savedConnections: SavedConnectionDbService;
    savedPipelines: SavedPipelineDbService;
    databaseExplorer: DatabaseExplorerService;
    queryService: QueryService;
    indexService: IndexAdminService;
    pipelineService: PipelineService;
    shellService: ShellService;
    serverStatusService: ServerStatusService;
}

/** The shape an MCP tool callback must return. */
export interface McpToolResult {
    content: { type: 'text'; text: string; }[];
    isError?: boolean;
    [key: string]: unknown;
}

/** Hints a client can use to reason about a tool before calling it. */
export interface McpToolAnnotations {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
}

/** Declaration of one MCP tool. */
export interface McpToolDefinition {
    title: string;
    description: string;
    inputSchema: Record<string, ZodTypeAny>;
    annotations: McpToolAnnotations;
}

/**
 * Minimal view of the SDK's registration surface.
 *
 * The SDK infers a tool's argument type from its Zod input schema. That inference is
 * quadratic enough that forty tools exhausts the TypeScript compiler's heap — and
 * because ts-node type-checks at run time, it would break `npm start` too. Erasing
 * the generic here and declaring each handler's arguments explicitly keeps both the
 * compiler and the runtime cheap; Zod still validates every call.
 */
interface ToolRegistrar {
    registerTool(name: string, config: McpToolDefinition, handler: (args: never) => Promise<McpToolResult>): unknown;
}

/** Registers one tool with explicitly typed handler arguments. */
export function defineTool<TArgs>(
    server: McpServer,
    name: string,
    definition: McpToolDefinition,
    handler: (args: TArgs) => Promise<McpToolResult>
): void {
    (server as unknown as ToolRegistrar).registerTool(
        name,
        definition,
        handler as unknown as (args: never) => Promise<McpToolResult>
    );
}

/** Annotations for a tool that only reads. */
export const READ_ONLY_TOOL: McpToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};

/** Annotations for a tool that changes interface state but no data. */
export const UI_CHANGE_TOOL: McpToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

/** Annotations for a tool that stages a proposal. Staging destroys nothing. */
export const PROPOSE_TOOL: McpToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

/** Wraps a value as a successful tool result. */
export function ok(value: unknown): McpToolResult {
    const text = typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
    return { content: [{ type: 'text', text }] };
}

/**
 * Wraps a structured refusal as an error result.
 *
 * Every refusal is actionable rather than a bare failure: the hint is written in the
 * imperative so a model can act on it instead of wasting a turn guessing.
 */
export function refuse(refusal: McpRefusal): McpToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(refusal, undefined, 2) }],
        isError: true,
    };
}

/** Wraps a thrown error as an error result, with secrets removed. */
export function fail(error: unknown, hint: string): McpToolResult {
    return refuse({
        code: 'invalid_argument',
        message: redactText(errorMessage(error)),
        hint,
    });
}

/**
 * The refusal returned whenever a write is requested. Its hint never suggests a
 * workaround exists, because none does.
 */
export function writesProhibited(operation: string): McpRefusal {
    return {
        code: 'writes_prohibited',
        message:
            `'${operation}' would write to a Target Database. AI-originated writes are structurally ` +
            'prohibited in Mongo Explorer; only the user executes data changes.',
        hint:
            'Stage the change with the matching propose_* tool. The user reviews the diff in the ' +
            'Proposals panel and executes it themselves. Do not look for another route.',
        detail: { operation },
    };
}

/** Parses a hex string into an ObjectId, throwing a useful message when invalid. */
export function toObjectId(value: string, label = 'id'): ObjectId {
    if (!ObjectId.isValid(value)) {
        throw new Error(`'${value}' is not a valid ${label}. Expected a 24-character hex string.`);
    }

    return new ObjectId(value);
}

/** Result of resolving a connection for a tool call. */
export type ConnectionResolution =
    | { ok: true; connection: LiveConnection; }
    | { ok: false; refusal: McpRefusal; };

/** Resolves and opens a connection, or explains why it could not be reached. */
export async function resolveConnection(context: McpToolContext, connectionIdHex: string): Promise<ConnectionResolution> {
    let connectionId: ObjectId;

    try {
        connectionId = toObjectId(connectionIdHex, 'connection id');
    } catch (error) {
        return {
            ok: false,
            refusal: {
                code: 'invalid_argument',
                message: errorMessage(error),
                hint: 'Call get_app_state or read mongo-explorer://connections to obtain valid connection ids.',
            },
        };
    }

    const existing = context.connectionManager.tryGet(connectionId);

    if (existing?.isUsable) {
        return { ok: true, connection: existing };
    }

    try {
        const connection = await context.connectionManager.connect(connectionId);
        return { ok: true, connection };
    } catch (error) {
        return {
            ok: false,
            refusal: {
                code: 'not_connected',
                message: redactText(errorMessage(error)),
                hint:
                    'The connection could not be opened. If it needs interactive sign-in, ask the user to ' +
                    'connect it in the application first, then retry.',
                detail: { connectionId: connectionIdHex },
            },
        };
    }
}

/** Runs a guard chain, returning the first refusal. */
export function firstRefusal(...checks: (McpRefusal | undefined)[]): McpRefusal | undefined {
    return checks.find(check => check !== undefined);
}

/** Guard chain for a tool that only reads. */
export function guardRead(context: McpToolContext): McpRefusal | undefined {
    return context.modeService.requireRead();
}

/** Guard chain for a tool that changes interface state. */
export function guardUiChange(
    context: McpToolContext,
    options: { expectedRevision?: number; dirtySurfaces?: readonly DirtySurface[]; description: string; }
): McpRefusal | undefined {
    return firstRefusal(
        context.modeService.requireUiChange(),
        context.sessionService.requireActiveSession(),
        context.sessionService.checkRevision(options.expectedRevision),
        options.dirtySurfaces?.length
            ? context.sessionService.checkDirtyState(options.dirtySurfaces, options.description)
            : undefined
    );
}

/** Guard chain for a tool that stages a proposal. */
export function guardProposal(context: McpToolContext, connection: LiveConnection): McpRefusal | undefined {
    const modeRefusal = context.modeService.requireProposal();

    if (modeRefusal) {
        return modeRefusal;
    }

    if (connection.isReadOnly) {
        return {
            code: 'read_only_connection',
            message: `Connection '${connection.connectionName}' is marked read-only, so no change can be staged against it.`,
            hint: 'Tell the user the connection is read-only. Only they can change that flag.',
            detail: { connectionName: connection.connectionName },
        };
    }

    return undefined;
}
