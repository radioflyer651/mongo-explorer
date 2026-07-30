import express from 'express';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { SavedConnectionDbService } from '../database/saved-connection-db.service';
import { ConnectionManager } from '../connections/connection-manager.service';
import { McpModeService } from '../mcp/mcp-mode.service';
import { validateBody } from './middleware/validate-body.middleware';
import { readObjectIdParam, sendError } from './route-helpers';
import { ConnectionStrategyKind, AzureOidcFlow } from '../model/shared-models/connections/connection-strategy-kind.model';
import { SaveConnectionRequest } from '../model/shared-models/connections/saved-connection.model';

/** Schema for saving a connection. The envelope is validated strictly. */
const saveConnectionSchema = z.object({
    _id: z.string().optional(),
    name: z.string().min(1, 'A connection name is required.'),
    strategyKind: z.nativeEnum(ConnectionStrategyKind),
    isReadOnly: z.boolean(),
    notes: z.string().optional(),
    colorTag: z.string().optional(),
    secret: z.string().optional(),
    config: z.object({
        connectionString: z
            .object({
                uri: z.string().min(1),
                defaultDatabase: z.string().optional(),
            })
            .optional(),
        scram: z
            .object({
                host: z.string().min(1),
                port: z.number().int().min(1).max(65_535),
                userName: z.string().min(1),
                hasStoredPassword: z.boolean().default(false),
                authSource: z.string().optional(),
                replicaSet: z.string().optional(),
                defaultDatabase: z.string().optional(),
            })
            .optional(),
        azureOidc: z
            .object({
                host: z.string().min(1),
                port: z.number().int().min(1).max(65_535),
                tenantId: z.string().min(1),
                clientId: z.string().min(1),
                flow: z.nativeEnum(AzureOidcFlow),
                tokenResource: z.string().min(1),
                allowedHosts: z.array(z.string()).min(1),
                principalName: z.string().optional(),
                hasStoredClientSecret: z.boolean().default(false),
                managedIdentityClientId: z.string().optional(),
                defaultDatabase: z.string().optional(),
            })
            .optional(),
        x509: z
            .object({
                host: z.string().min(1),
                port: z.number().int().min(1).max(65_535),
                certificateKeyFilePath: z.string().min(1),
                hasStoredPassphrase: z.boolean().default(false),
                defaultDatabase: z.string().optional(),
            })
            .optional(),
        transport: z
            .object({
                useTls: z.boolean().optional(),
                tlsCaFilePath: z.string().optional(),
                tlsAllowInvalidCertificates: z.boolean().optional(),
                retryWrites: z.boolean().optional(),
                serverSelectionTimeoutMs: z.number().int().min(100).optional(),
            })
            .optional(),
    }),
});

/** Connection management routes. */
export function createConnectionsRouter(
    savedConnections: SavedConnectionDbService,
    connectionManager: ConnectionManager,
    modeService: McpModeService
) {
    const router = express.Router();

    router.get('/api/connections', async (_req, res) => {
        try {
            res.json(await savedConnections.getConnectionListings());
        } catch (error) {
            sendError(res, error, 'Could not list connections.');
        }
    });

    router.get('/api/connections/strategies', (_req, res) => {
        res.json(
            connectionManager.availableStrategies.map(strategy => ({
                kind: strategy.kind,
                displayName: strategy.displayName,
                requiresRefresh: strategy.requiresRefresh,
            }))
        );
    });

    router.get('/api/connections/statuses', (_req, res) => {
        res.json(connectionManager.getAllStatuses());
    });

    router.post('/api/connections', validateBody(saveConnectionSchema), async (req, res) => {
        try {
            const body = req.body as z.infer<typeof saveConnectionSchema>;

            const request: SaveConnectionRequest = {
                ...body,
                _id: body._id ? new ObjectId(body._id) : undefined,
            } as SaveConnectionRequest;

            res.json(await savedConnections.saveConnection(request));
        } catch (error) {
            sendError(res, error, 'Could not save the connection.');
        }
    });

    router.delete('/api/connections/:connectionId', async (req, res) => {
        const connectionId = readObjectIdParam(req, res, 'connectionId');

        if (!connectionId) {
            return;
        }

        try {
            await connectionManager.disconnect(connectionId);
            const removed = await savedConnections.deleteConnection(connectionId);

            if (!removed) {
                res.status(404).json({ message: 'No such connection.' });
                return;
            }

            res.json({ deleted: true });
        } catch (error) {
            sendError(res, error, 'Could not delete the connection.');
        }
    });

    router.post('/api/connections/:connectionId/read-only', async (req, res) => {
        const connectionId = readObjectIdParam(req, res, 'connectionId');

        if (!connectionId) {
            return;
        }

        try {
            const isReadOnly = (req.body as { isReadOnly?: boolean; }).isReadOnly === true;
            await savedConnections.setReadOnly(connectionId, isReadOnly);

            /* A read-only connection narrows what an AI may do to the interface too. */
            await modeService.applyReadOnlyNarrowing(isReadOnly);

            res.json({ connectionId, isReadOnly });
        } catch (error) {
            sendError(res, error, 'Could not change the read-only flag.');
        }
    });

    router.get('/api/connections/:connectionId/validate', async (req, res) => {
        const connectionId = readObjectIdParam(req, res, 'connectionId');

        if (!connectionId) {
            return;
        }

        try {
            res.json(await connectionManager.validate(connectionId));
        } catch (error) {
            sendError(res, error, 'Could not validate the connection.');
        }
    });

    router.post('/api/connections/:connectionId/connect', async (req, res) => {
        const connectionId = readObjectIdParam(req, res, 'connectionId');

        if (!connectionId) {
            return;
        }

        try {
            const connection = await connectionManager.connect(connectionId);
            await modeService.applyReadOnlyNarrowing(connection.isReadOnly);
            res.json(connection.status);
        } catch (error) {
            sendError(res, error, 'The connection could not be opened.');
        }
    });

    router.post('/api/connections/:connectionId/disconnect', async (req, res) => {
        const connectionId = readObjectIdParam(req, res, 'connectionId');

        if (!connectionId) {
            return;
        }

        try {
            await connectionManager.disconnect(connectionId);
            res.json({ disconnected: true });
        } catch (error) {
            sendError(res, error, 'Could not close the connection.');
        }
    });

    router.post('/api/connections/:connectionId/cancel', (req, res) => {
        const connectionId = readObjectIdParam(req, res, 'connectionId');

        if (!connectionId) {
            return;
        }

        connectionManager.cancelConnect(connectionId);
        res.json({ cancelled: true });
    });

    return router;
}
