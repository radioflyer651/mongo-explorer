import express from 'express';
import { z } from 'zod';
import { ConnectionManager } from '../connections/connection-manager.service';
import { ShellService } from '../explorer/shell.service';
import { validateBody } from './middleware/validate-body.middleware';
import { resolveConnectionParam, sendError } from './route-helpers';
import { ShellTier } from '../model/shared-models/explorer/shell.model';

/** Schema for a shell submission. */
const executeSchema = z.object({
    databaseName: z.string().min(1),
    input: z.string().min(1),
    maxTimeMs: z.number().int().min(100).optional(),
});

/**
 * Tier A shell routes: structured commands over the existing LiveConnection.
 *
 * The full mongosh tier is not implemented. It cannot share this connection, which
 * matters most for OIDC connections where the token lives in this process.
 */
export function createShellRouter(connectionManager: ConnectionManager, shellService: ShellService) {
    const router = express.Router();

    router.get('/api/shell/transcript', (_req, res) => {
        res.json(shellService.getTranscript());
    });

    router.delete('/api/shell/transcript', (_req, res) => {
        shellService.clearTranscript();
        res.json({ cleared: true });
    });

    router.post('/api/shell/classify', validateBody(z.object({ input: z.string() })), (req, res) => {
        res.json(shellService.classify((req.body as { input: string; }).input));
    });

    router.post('/api/connections/:connectionId/shell/execute', validateBody(executeSchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof executeSchema>;

            const entry = await shellService.execute(
                connection,
                {
                    connectionId: connection.connectionId,
                    databaseName: body.databaseName,
                    input: body.input,
                    tier: ShellTier.CommandRunner,
                    maxTimeMs: body.maxTimeMs,
                },
                'user'
            );

            res.json(entry);
        } catch (error) {
            sendError(res, error, 'The shell command failed.');
        }
    });

    return router;
}
