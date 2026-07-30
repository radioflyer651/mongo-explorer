import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    McpToolContext,
    McpToolResult,
    READ_ONLY_TOOL,
    UI_CHANGE_TOOL,
    defineTool,
    fail,
    guardRead,
    guardUiChange,
    ok,
    refuse,
    resolveConnection,
} from '../mcp-tool-context';
import { DirtySurface } from '../../model/shared-models/mcp/app-session-state.model';
import { parseExtendedJsonObject } from '../../utils/ejson.util';

/** Every interface tool accepts an optional revision for staleness checking. */
interface RevisionArgs {
    expectedRevision?: number;
}

/**
 * Tools that change what the user is looking at. Gated by the AI mode switch, the
 * dirty-state veto, and the revision check — all enforced server-side, so a client
 * that mis-renders the switch cannot widen what an AI may do.
 *
 * Each one dispatches a registered command through the client, so an AI drives the
 * interface through exactly the same path a menu item uses.
 */
export function registerUiTools(server: McpServer, context: McpToolContext): void {
    const revisionSchema = { expectedRevision: z.number().int().optional() };

    /** Sends a mutation and records it in the attribution log when it lands. */
    async function dispatch(
        commandId: string,
        args: Record<string, unknown>,
        description: string,
        options: { expectedRevision?: number; dirtySurfaces?: readonly DirtySurface[]; }
    ): Promise<McpToolResult> {
        const refusal = guardUiChange(context, { ...options, description });

        if (refusal) {
            return refuse(refusal);
        }

        const result = await context.sessionService.requestMutation(commandId, args, description);

        if (!result.applied) {
            return refuse({
                code: 'invalid_argument',
                message: result.error ?? 'The application refused the change.',
                hint: 'Call get_app_state to read the current state, then reconsider.',
            });
        }

        context.activityService.record({
            actor: 'mcp',
            action: commandId,
            description,
            isUndoable: result.undoPayload !== undefined,
            undoPayload: result.undoPayload,
        });

        return ok({ applied: true, description, revision: context.sessionService.revision });
    }

    defineTool<RevisionArgs & { connectionId: string; databaseName: string; collectionName: string; }>(
        server,
        'open_collection',
        {
            title: 'Open a collection',
            description: 'Opens a collection in a tab and focuses it, so the user sees what you are talking about.',
            inputSchema: {
                connectionId: z.string(),
                databaseName: z.string(),
                collectionName: z.string(),
                ...revisionSchema,
            },
            annotations: UI_CHANGE_TOOL,
        },
        async args =>
            await dispatch(
                'collection.open',
                {
                    connectionId: args.connectionId,
                    databaseName: args.databaseName,
                    collectionName: args.collectionName,
                },
                `Opened ${args.databaseName}.${args.collectionName}`,
                { expectedRevision: args.expectedRevision }
            )
    );

    defineTool<RevisionArgs & { viewId: string; }>(
        server,
        'set_active_view',
        {
            title: 'Change the active view',
            description:
                'Switches the current collection between registered views such as table, json, or list. Filter, ' +
                'sort, and selection are preserved across the switch.',
            inputSchema: { viewId: z.enum(['table', 'json', 'list']), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args =>
            await dispatch('view.setActive', { viewId: args.viewId }, `Switched to the ${args.viewId} view`, {
                expectedRevision: args.expectedRevision,
            })
    );

    defineTool<RevisionArgs & { filter?: string; projection?: string; sort?: string; limit?: number; skip?: number; }>(
        server,
        'set_query',
        {
            title: 'Set the query',
            description:
                'Writes a filter, projection, sort, and page size into the user\'s query bar without running it. ' +
                'This is the main way to collaborate: the user sees the query, can edit it, and runs it ' +
                'themselves. Refused when the user has unsaved document edits.',
            inputSchema: {
                filter: z.string().optional().describe('Extended JSON filter.'),
                projection: z.string().optional(),
                sort: z.string().optional(),
                limit: z.number().int().min(1).optional(),
                skip: z.number().int().min(0).optional(),
                ...revisionSchema,
            },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            /* Validate before dispatching, so a malformed filter fails here with a
               useful message rather than silently in the browser. */
            for (const [label, value] of [
                ['filter', args.filter],
                ['projection', args.projection],
                ['sort', args.sort],
            ] as const) {
                if (value) {
                    try {
                        parseExtendedJsonObject(value, label);
                    } catch (error) {
                        return fail(error, `Correct the ${label} so it is valid Extended JSON, then retry.`);
                    }
                }
            }

            return await dispatch(
                'query.set',
                {
                    filter: args.filter,
                    projection: args.projection,
                    sort: args.sort,
                    limit: args.limit,
                    skip: args.skip,
                },
                `Set the query filter to ${args.filter ?? '{}'}`,
                { expectedRevision: args.expectedRevision, dirtySurfaces: ['documentEdits'] }
            );
        }
    );

    defineTool<RevisionArgs>(
        server,
        'run_query',
        {
            title: 'Run the current query',
            description:
                'Executes the query currently in the user\'s query bar. This is a read, so it is permitted — but ' +
                'it still needs Collaborate mode because it changes what is displayed.',
            inputSchema: revisionSchema,
            annotations: { ...READ_ONLY_TOOL, idempotentHint: false },
        },
        async args => await dispatch('query.run', {}, 'Ran the current query', { expectedRevision: args.expectedRevision })
    );

    defineTool<RevisionArgs & { documentIdsJson: string; }>(
        server,
        'set_selection',
        {
            title: 'Select documents',
            description:
                'Selects documents by identifier. Identifiers are passed as Extended JSON because a Target ' +
                'Database _id can be any BSON type, not necessarily an ObjectId.',
            inputSchema: {
                documentIdsJson: z.string().describe('Extended JSON array of _id values.'),
                ...revisionSchema,
            },
            annotations: UI_CHANGE_TOOL,
        },
        async args =>
            await dispatch(
                'selection.set',
                { documentIdsJson: args.documentIdsJson },
                'Changed the document selection',
                { expectedRevision: args.expectedRevision }
            )
    );

    defineTool<RevisionArgs>(
        server,
        'clear_selection',
        {
            title: 'Clear the selection',
            description: 'Clears the current document selection.',
            inputSchema: revisionSchema,
            annotations: UI_CHANGE_TOOL,
        },
        async args =>
            await dispatch('selection.clear', {}, 'Cleared the selection', { expectedRevision: args.expectedRevision })
    );

    defineTool<RevisionArgs & { tabId: string; }>(
        server,
        'focus_tab',
        {
            title: 'Focus a tab',
            description: 'Brings an already-open tab to the front.',
            inputSchema: { tabId: z.string(), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args =>
            await dispatch('tab.focus', { tabId: args.tabId }, 'Focused a tab', {
                expectedRevision: args.expectedRevision,
            })
    );

    defineTool<RevisionArgs & { tabId: string; }>(
        server,
        'close_tab',
        {
            title: 'Close a tab',
            description: 'Closes an open tab. Refused when that tab holds unsaved work.',
            inputSchema: { tabId: z.string(), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args =>
            await dispatch('tab.close', { tabId: args.tabId }, 'Closed a tab', {
                expectedRevision: args.expectedRevision,
                dirtySurfaces: ['documentEdits', 'pipelineBuilder', 'shellInput'],
            })
    );

    defineTool<{ connectionId: string; }>(
        server,
        'connect_connection',
        {
            title: 'Open a connection',
            description:
                'Opens a saved connection. When the connection needs interactive sign-in — a device code or ' +
                'browser consent — this reports that state: you cannot complete an interactive sign-in on the ' +
                'user\'s behalf.',
            inputSchema: { connectionId: z.string() },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = context.modeService.requireUiChange();

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            context.activityService.record({
                actor: 'mcp',
                action: 'connection.connect',
                description: `Opened connection '${resolved.connection.connectionName}'`,
            });

            return ok({
                connectionId: args.connectionId,
                state: resolved.connection.state,
                capabilities: resolved.connection.serverCapabilities,
            });
        }
    );

    defineTool<{ connectionId: string; }>(
        server,
        'disconnect_connection',
        {
            title: 'Close a connection',
            description: 'Closes a live connection and releases its resources.',
            inputSchema: { connectionId: z.string() },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = context.modeService.requireUiChange();

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            await context.connectionManager.disconnect(resolved.connection.connectionId);
            return ok({ connectionId: args.connectionId, disconnected: true });
        }
    );

    defineTool<Record<string, never>>(
        server,
        'get_current_results',
        {
            title: 'Get the visible documents',
            description:
                'Returns the page of documents currently on screen, as Extended JSON, with truncation flags. Use ' +
                'this to reason about exactly what the user is looking at.',
            inputSchema: {},
            annotations: READ_ONLY_TOOL,
        },
        async () => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const state = context.sessionService.getState();

            if (!state.currentView) {
                return refuse({
                    code: 'no_active_session',
                    message: 'No collection view is currently open.',
                    hint: 'Use open_collection first, or use find_documents to read without changing the interface.',
                });
            }

            const resolved = await resolveConnection(context, state.currentView.connectionId.toString());

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                const page = await context.queryService.findDocuments(resolved.connection, {
                    connectionId: resolved.connection.connectionId,
                    databaseName: state.currentView.databaseName,
                    collectionName: state.currentView.collectionName,
                    filter: state.currentView.filter,
                    projection: state.currentView.projection,
                    sort: state.currentView.sort,
                    limit: state.currentView.limit,
                    skip: state.currentView.skip,
                });

                return ok({ view: state.currentView, page });
            } catch (error) {
                return fail(error, 'The stored view filter may be invalid. Read get_app_state and correct it with set_query.');
            }
        }
    );
}
