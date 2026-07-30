import express from 'express';
import { z } from 'zod';
import { ConnectionManager } from '../connections/connection-manager.service';
import { DatabaseExplorerService } from '../explorer/database-explorer.service';
import { QueryService } from '../explorer/query.service';
import { DocumentService } from '../explorer/document.service';
import { IndexAdminService } from '../explorer/index-admin.service';
import { ServerStatusService } from '../explorer/server-status.service';
import { ProposalService } from '../mcp/proposal.service';
import { QueryHistoryDbService } from '../database/query-history-db.service';
import { validateBody } from './middleware/validate-body.middleware';
import { readNumberQuery, readParam, readStringQuery, resolveConnectionParam, sendError } from './route-helpers';

/**
 * Target Database exploration routes.
 *
 * Every write here passes actor 'user': these endpoints are reached only from a
 * user gesture in the browser. The MCP server has no route into them — it stages
 * proposals instead.
 */
export function createExplorerRouter(
    connectionManager: ConnectionManager,
    databaseExplorer: DatabaseExplorerService,
    queryService: QueryService,
    documentService: DocumentService,
    indexService: IndexAdminService,
    serverStatusService: ServerStatusService,
    proposalService: ProposalService,
    queryHistory: QueryHistoryDbService
) {
    const router = express.Router();
    const base = '/api/connections/:connectionId';

    /* ---------- Databases and collections ---------- */

    router.get(`${base}/databases`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(await databaseExplorer.listDatabases(connection));
        } catch (error) {
            sendError(res, error, 'Could not list databases.');
        }
    });

    router.get(`${base}/databases/:databaseName/collections`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(await databaseExplorer.listCollections(connection, readParam(req, 'databaseName')));
        } catch (error) {
            sendError(res, error, 'Could not list collections.');
        }
    });

    router.get(`${base}/databases/:databaseName/collections/:collectionName/stats`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(
                await databaseExplorer.getCollectionStats(
                    connection,
                    readParam(req, 'databaseName'),
                    readParam(req, 'collectionName')
                )
            );
        } catch (error) {
            sendError(res, error, 'Could not read collection statistics.');
        }
    });

    router.post(`${base}/databases/:databaseName/collections`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const name = (req.body as { collectionName?: string; }).collectionName ?? '';
            await databaseExplorer.createCollection(connection, readParam(req, 'databaseName'), name, 'user');
            res.json({ created: true, collectionName: name });
        } catch (error) {
            sendError(res, error, 'Could not create the collection.');
        }
    });

    router.delete(`${base}/databases/:databaseName/collections/:collectionName`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            await databaseExplorer.dropCollection(
                connection,
                readParam(req, 'databaseName'),
                readParam(req, 'collectionName'),
                'user'
            );

            proposalService.markStaleForCollection(
                readParam(req, 'databaseName'),
                readParam(req, 'collectionName'),
                'The collection was dropped.'
            );

            res.json({ dropped: true });
        } catch (error) {
            sendError(res, error, 'Could not drop the collection.');
        }
    });

    router.post(`${base}/databases/:databaseName/collections/:collectionName/rename`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const newName = (req.body as { newName?: string; }).newName ?? '';
            await databaseExplorer.renameCollection(
                connection,
                readParam(req, 'databaseName'),
                readParam(req, 'collectionName'),
                newName,
                'user'
            );
            res.json({ renamed: true, newName });
        } catch (error) {
            sendError(res, error, 'Could not rename the collection.');
        }
    });

    router.delete(`${base}/databases/:databaseName`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            await databaseExplorer.dropDatabase(connection, readParam(req, 'databaseName'), 'user');
            res.json({ dropped: true });
        } catch (error) {
            sendError(res, error, 'Could not drop the database.');
        }
    });

    /* ---------- Documents ---------- */

    const collectionBase = `${base}/databases/:databaseName/collections/:collectionName`;

    router.get(`${collectionBase}/documents`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const page = await queryService.findDocuments(connection, {
                connectionId: connection.connectionId,
                databaseName: readParam(req, 'databaseName'),
                collectionName: readParam(req, 'collectionName'),
                filter: readStringQuery(req, 'filter'),
                projection: readStringQuery(req, 'projection'),
                sort: readStringQuery(req, 'sort'),
                limit: readNumberQuery(req, 'limit') ?? 50,
                skip: readNumberQuery(req, 'skip') ?? 0,
                maxTimeMs: readNumberQuery(req, 'maxTimeMs'),
            });

            void queryHistory.recordQuery({
                connectionId: connection.connectionId,
                databaseName: readParam(req, 'databaseName'),
                collectionName: readParam(req, 'collectionName'),
                filter: readStringQuery(req, 'filter'),
                projection: readStringQuery(req, 'projection'),
                sort: readStringQuery(req, 'sort'),
                durationMs: page.durationMs,
                returnedCount: page.returnedCount,
            });

            res.json(page);
        } catch (error) {
            sendError(res, error, 'The query failed.');
        }
    });

    router.get(`${collectionBase}/count`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(
                await queryService.countDocuments(connection, {
                    connectionId: connection.connectionId,
                    databaseName: readParam(req, 'databaseName'),
                    collectionName: readParam(req, 'collectionName'),
                    filter: readStringQuery(req, 'filter'),
                })
            );
        } catch (error) {
            sendError(res, error, 'The count failed.');
        }
    });

    router.get(`${collectionBase}/schema`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(
                await queryService.inferSchema(
                    connection,
                    readParam(req, 'databaseName'),
                    readParam(req, 'collectionName'),
                    readNumberQuery(req, 'sampleSize')
                )
            );
        } catch (error) {
            sendError(res, error, 'Schema inference failed.');
        }
    });

    router.get(`${collectionBase}/explain`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(
                await queryService.explainQuery(connection, {
                    connectionId: connection.connectionId,
                    databaseName: readParam(req, 'databaseName'),
                    collectionName: readParam(req, 'collectionName'),
                    filter: readStringQuery(req, 'filter'),
                    sort: readStringQuery(req, 'sort'),
                    limit: readNumberQuery(req, 'limit') ?? 50,
                    skip: 0,
                })
            );
        } catch (error) {
            sendError(res, error, 'Explain failed.');
        }
    });

    const documentsBodySchema = z.object({
        documentsJson: z.string().optional(),
        filterJson: z.string().optional(),
        updateJson: z.string().optional(),
        isMany: z.boolean().optional(),
    });

    router.post(`${collectionBase}/documents`, validateBody(documentsBodySchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof documentsBodySchema>;
            const ref = {
                connectionId: connection.connectionId,
                databaseName: readParam(req, 'databaseName'),
                collectionName: readParam(req, 'collectionName'),
            };

            const outcome = await documentService.insertDocuments(connection, ref, body.documentsJson ?? '[]', 'user');
            proposalService.markStaleForCollection(ref.databaseName, ref.collectionName, 'Documents were inserted.');
            res.json(outcome);
        } catch (error) {
            sendError(res, error, 'The insert failed.');
        }
    });

    router.patch(`${collectionBase}/documents`, validateBody(documentsBodySchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof documentsBodySchema>;
            const ref = {
                connectionId: connection.connectionId,
                databaseName: readParam(req, 'databaseName'),
                collectionName: readParam(req, 'collectionName'),
            };

            const outcome = await documentService.updateDocuments(
                connection,
                ref,
                body.filterJson ?? '{}',
                body.updateJson ?? '{}',
                body.isMany === true,
                'user'
            );

            proposalService.markStaleForCollection(ref.databaseName, ref.collectionName, 'Documents were updated.');
            res.json(outcome);
        } catch (error) {
            sendError(res, error, 'The update failed.');
        }
    });

    router.put(`${collectionBase}/documents`, validateBody(documentsBodySchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof documentsBodySchema>;
            const ref = {
                connectionId: connection.connectionId,
                databaseName: readParam(req, 'databaseName'),
                collectionName: readParam(req, 'collectionName'),
            };

            const outcome = await documentService.replaceDocument(
                connection,
                ref,
                body.filterJson ?? '{}',
                body.documentsJson ?? '{}',
                'user'
            );

            proposalService.markStaleForCollection(ref.databaseName, ref.collectionName, 'A document was replaced.');
            res.json(outcome);
        } catch (error) {
            sendError(res, error, 'The replacement failed.');
        }
    });

    router.post(`${collectionBase}/documents/delete`, validateBody(documentsBodySchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof documentsBodySchema>;
            const ref = {
                connectionId: connection.connectionId,
                databaseName: readParam(req, 'databaseName'),
                collectionName: readParam(req, 'collectionName'),
            };

            const outcome = await documentService.deleteDocuments(
                connection,
                ref,
                body.filterJson ?? '{}',
                body.isMany === true,
                'user'
            );

            proposalService.markStaleForCollection(ref.databaseName, ref.collectionName, 'Documents were deleted.');
            res.json(outcome);
        } catch (error) {
            sendError(res, error, 'The deletion failed.');
        }
    });

    /* ---------- Indexes ---------- */

    router.get(`${collectionBase}/indexes`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(await indexService.listIndexes(connection, readParam(req, 'databaseName'), readParam(req, 'collectionName')));
        } catch (error) {
            sendError(res, error, 'Could not list indexes.');
        }
    });

    const indexBodySchema = z.object({
        keyJson: z.string(),
        name: z.string().optional(),
        unique: z.boolean().optional(),
        sparse: z.boolean().optional(),
        expireAfterSeconds: z.number().int().min(0).optional(),
        partialFilterExpressionJson: z.string().optional(),
    });

    router.post(`${collectionBase}/indexes`, validateBody(indexBodySchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof indexBodySchema>;

            const name = await indexService.createIndex(
                connection,
                readParam(req, 'databaseName'),
                readParam(req, 'collectionName'),
                body.keyJson,
                body,
                'user'
            );

            res.json({ created: true, name });
        } catch (error) {
            sendError(res, error, 'Could not create the index.');
        }
    });

    router.delete(`${collectionBase}/indexes/:indexName`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            await indexService.dropIndex(
                connection,
                readParam(req, 'databaseName'),
                readParam(req, 'collectionName'),
                readParam(req, 'indexName'),
                'user'
            );

            res.json({ dropped: true });
        } catch (error) {
            sendError(res, error, 'Could not drop the index.');
        }
    });

    /* ---------- Deployment diagnostics ---------- */

    router.get(`${base}/server-status`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(await serverStatusService.getServerStatus(connection));
        } catch (error) {
            sendError(res, error, 'Could not read server status.');
        }
    });

    router.get(`${base}/current-operations`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(await serverStatusService.getCurrentOperations(connection));
        } catch (error) {
            sendError(res, error, 'Could not list current operations.');
        }
    });

    router.post(`${base}/current-operations/:operationId/kill`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            await serverStatusService.killOperation(connection, readParam(req, 'operationId'), 'user');
            res.json({ killed: true });
        } catch (error) {
            sendError(res, error, 'Could not kill the operation.');
        }
    });

    /* ---------- Query history ---------- */

    router.get(`${collectionBase}/history`, async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            res.json(
                await queryHistory.getHistory(
                    connection.connectionId,
                    readParam(req, 'databaseName'),
                    readParam(req, 'collectionName'),
                    readNumberQuery(req, 'limit') ?? 25
                )
            );
        } catch (error) {
            sendError(res, error, 'Could not read query history.');
        }
    });

    return router;
}
