import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    McpToolContext,
    READ_ONLY_TOOL,
    defineTool,
    fail,
    guardRead,
    ok,
    refuse,
    resolveConnection,
} from '../mcp-tool-context';

/** Arguments naming a connection. */
interface ConnectionArgs {
    connectionId: string;
}

/** Arguments naming a database. */
interface DatabaseArgs extends ConnectionArgs {
    databaseName: string;
}

/** Arguments naming a collection. */
interface CollectionArgs extends DatabaseArgs {
    collectionName: string;
}

/** Arguments for a bounded find. */
interface FindArgs extends CollectionArgs {
    filter?: string;
    projection?: string;
    sort?: string;
    limit?: number;
    skip?: number;
}

/**
 * Read-only tools. These make an AI useful, and none of them can change anything.
 *
 * Every one reports truncation explicitly: a silently capped result would lead to
 * confident wrong conclusions, which is worse than an error.
 */
export function registerReadTools(server: McpServer, context: McpToolContext): void {
    const connectionSchema = { connectionId: z.string().describe('Saved connection id.') };
    const databaseSchema = { ...connectionSchema, databaseName: z.string() };
    const collectionSchema = { ...databaseSchema, collectionName: z.string() };

    defineTool<Record<string, never>>(
        server,
        'get_app_state',
        {
            title: 'Get application state',
            description:
                'Returns what the user is currently looking at: active connection, open tabs, current ' +
                'collection view with its filter and sort, pipeline builder state, shell state, pending ' +
                'proposals, unsaved-work regions, and a revision number. Pass the revision back to mutating ' +
                'tools so you do not act on a view the user has moved on from.',
            inputSchema: {},
            annotations: READ_ONLY_TOOL,
        },
        async () => {
            const refusal = guardRead(context);
            return refusal ? refuse(refusal) : ok(context.sessionService.getState());
        }
    );

    defineTool<Record<string, never>>(
        server,
        'get_mcp_mode',
        {
            title: 'Get AI permission mode',
            description:
                'Returns the current AI mode and exactly what it permits. Readable in every mode, including ' +
                'Off, so you can always explain why an action is unavailable. No mode ever permits an AI to ' +
                'execute a data change.',
            inputSchema: {},
            annotations: READ_ONLY_TOOL,
        },
        async () =>
            ok({
                mode: context.modeService.currentMode,
                capabilities: context.modeService.capabilities,
                note:
                    'canExecuteDataChanges is false in every mode, permanently. Data changes are staged as ' +
                    'proposals and executed by the user.',
            })
    );

    defineTool<{ limit?: number; }>(
        server,
        'get_activity_log',
        {
            title: 'Get activity log',
            description:
                'Recent changes with actor attribution, so you can see what you changed versus what the user ' +
                'changed.',
            inputSchema: { limit: z.number().int().min(1).max(200).optional() },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);
            return refusal ? refuse(refusal) : ok(context.activityService.getRecent(args.limit ?? 50));
        }
    );

    defineTool<Record<string, never>>(
        server,
        'list_connections',
        {
            title: 'List saved connections',
            description:
                'Lists saved Target Database connections. Returns names, endpoints, and strategy kinds only — ' +
                'never credentials.',
            inputSchema: {},
            annotations: READ_ONLY_TOOL,
        },
        async () => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            return ok(await context.savedConnections.getConnectionListings());
        }
    );

    defineTool<ConnectionArgs>(
        server,
        'list_databases',
        {
            title: 'List databases',
            description: 'Lists databases on a Target Database deployment.',
            inputSchema: connectionSchema,
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(await context.databaseExplorer.listDatabases(resolved.connection));
            } catch (error) {
                return fail(error, 'Check that the user has permission to list databases on this deployment.');
            }
        }
    );

    defineTool<DatabaseArgs>(
        server,
        'list_collections',
        {
            title: 'List collections',
            description:
                'Lists collections in one database, with document counts and sizes where the deployment ' +
                'reports them.',
            inputSchema: databaseSchema,
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(await context.databaseExplorer.listCollections(resolved.connection, args.databaseName));
            } catch (error) {
                return fail(error, 'Verify the database name with list_databases.');
            }
        }
    );

    defineTool<CollectionArgs>(
        server,
        'get_collection_stats',
        {
            title: 'Get collection statistics',
            description: 'Returns document count, sizes, and index counts for one collection.',
            inputSchema: collectionSchema,
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.databaseExplorer.getCollectionStats(
                        resolved.connection,
                        args.databaseName,
                        args.collectionName
                    )
                );
            } catch (error) {
                return fail(error, 'Verify the collection name with list_collections.');
            }
        }
    );

    defineTool<FindArgs>(
        server,
        'find_documents',
        {
            title: 'Find documents',
            description:
                'Runs a bounded find and returns one page as Extended JSON. Filter, projection, and sort are ' +
                'Extended JSON strings. The page size is capped server-side; check isPartial and hasMore before ' +
                'drawing any conclusion about totals.',
            inputSchema: {
                ...collectionSchema,
                filter: z.string().optional().describe('Extended JSON filter, for example {"status":"active"}.'),
                projection: z.string().optional(),
                sort: z.string().optional(),
                limit: z.number().int().min(1).optional(),
                skip: z.number().int().min(0).optional(),
            },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.queryService.findDocuments(resolved.connection, {
                        connectionId: resolved.connection.connectionId,
                        databaseName: args.databaseName,
                        collectionName: args.collectionName,
                        filter: args.filter,
                        projection: args.projection,
                        sort: args.sort,
                        limit: args.limit ?? 50,
                        skip: args.skip ?? 0,
                    })
                );
            } catch (error) {
                return fail(error, 'Check that the filter, projection, and sort are valid Extended JSON.');
            }
        }
    );

    defineTool<CollectionArgs & { filter?: string; }>(
        server,
        'count_documents',
        {
            title: 'Count documents',
            description: 'Counts documents matching a filter. Reports whether the count is exact or an estimate.',
            inputSchema: { ...collectionSchema, filter: z.string().optional() },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.queryService.countDocuments(resolved.connection, {
                        connectionId: resolved.connection.connectionId,
                        databaseName: args.databaseName,
                        collectionName: args.collectionName,
                        filter: args.filter,
                    })
                );
            } catch (error) {
                return fail(error, 'Check that the filter is valid Extended JSON.');
            }
        }
    );

    defineTool<CollectionArgs & { sampleSize?: number; }>(
        server,
        'sample_documents',
        {
            title: 'Sample documents',
            description:
                'Returns a random sample of documents. The cheap way to understand a collection you have not ' +
                'seen before.',
            inputSchema: { ...collectionSchema, sampleSize: z.number().int().min(1).max(200).optional() },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.queryService.sampleDocuments(
                        resolved.connection,
                        args.databaseName,
                        args.collectionName,
                        args.sampleSize
                    )
                );
            } catch (error) {
                return fail(error, 'Verify the collection exists with list_collections.');
            }
        }
    );

    defineTool<CollectionArgs & { sampleSize?: number; }>(
        server,
        'infer_schema',
        {
            title: 'Infer collection schema',
            description:
                'Samples a collection and reports every field path, the BSON types seen at it, and how often ' +
                'each appears. Note that null and absent are reported as distinct types, because in MongoDB ' +
                'they are different things.',
            inputSchema: { ...collectionSchema, sampleSize: z.number().int().min(1).max(1000).optional() },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.queryService.inferSchema(
                        resolved.connection,
                        args.databaseName,
                        args.collectionName,
                        args.sampleSize
                    )
                );
            } catch (error) {
                return fail(error, 'Verify the collection exists with list_collections.');
            }
        }
    );

    defineTool<CollectionArgs>(
        server,
        'list_indexes',
        {
            title: 'List indexes',
            description: 'Lists indexes on a collection, with sizes where the deployment reports them.',
            inputSchema: collectionSchema,
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.indexService.listIndexes(resolved.connection, args.databaseName, args.collectionName)
                );
            } catch (error) {
                return fail(error, 'Verify the collection exists with list_collections.');
            }
        }
    );

    defineTool<CollectionArgs & { filter?: string; sort?: string; limit?: number; }>(
        server,
        'explain_query',
        {
            title: 'Explain a query',
            description:
                'Returns the execution plan for a find, including whether an index was used and how many ' +
                'documents were examined. Reading a plan and telling the user why their query is slow is among ' +
                'the most valuable things you can do here.',
            inputSchema: {
                ...collectionSchema,
                filter: z.string().optional(),
                sort: z.string().optional(),
                limit: z.number().int().min(1).optional(),
            },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.queryService.explainQuery(resolved.connection, {
                        connectionId: resolved.connection.connectionId,
                        databaseName: args.databaseName,
                        collectionName: args.collectionName,
                        filter: args.filter,
                        sort: args.sort,
                        limit: args.limit ?? 50,
                        skip: 0,
                    })
                );
            } catch (error) {
                return fail(error, 'Check that the filter and sort are valid Extended JSON.');
            }
        }
    );

    defineTool<ConnectionArgs>(
        server,
        'get_server_info',
        {
            title: 'Get server information',
            description:
                'Returns the deployment version, inferred family (Atlas, Cosmos vCore, self-hosted), and which ' +
                'commands were detected as available. Consult this before assuming a feature exists.',
            inputSchema: connectionSchema,
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            return ok({
                capabilities: resolved.connection.serverCapabilities,
                state: resolved.connection.state,
                isReadOnly: resolved.connection.isReadOnly,
            });
        }
    );

    defineTool<ConnectionArgs>(
        server,
        'get_server_status',
        {
            title: 'Get server status',
            description: 'Returns live deployment metrics: uptime, connection counts, and operation counters.',
            inputSchema: connectionSchema,
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(await context.serverStatusService.getServerStatus(resolved.connection));
            } catch (error) {
                return fail(error, 'This deployment may refuse serverStatus. Check get_server_info for what is available.');
            }
        }
    );
}
