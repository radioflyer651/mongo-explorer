import express from 'express';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { ConnectionManager } from '../connections/connection-manager.service';
import { PipelineService } from '../explorer/pipeline.service';
import { SavedPipelineDbService } from '../database/saved-pipeline-db.service';
import { validateBody } from './middleware/validate-body.middleware';
import { readObjectIdParam, readParam, resolveConnectionParam, sendError } from './route-helpers';
import { PipelineStage } from '../model/shared-models/explorer/pipeline.model';

/** Schema for one builder stage. */
const stageSchema = z.object({
    id: z.string(),
    operator: z.string(),
    body: z.string(),
    isEnabled: z.boolean(),
    comment: z.string().optional(),
});

/** Schema for a preview or explain request. */
const runSchema = z.object({
    stages: z.array(stageSchema),
    upToStageIndex: z.number().int().min(0).optional(),
    sampleSize: z.number().int().min(1).optional(),
    maxTimeMs: z.number().int().min(100).optional(),
});

/** Aggregation pipeline routes. */
export function createPipelineRouter(
    connectionManager: ConnectionManager,
    pipelineService: PipelineService,
    savedPipelines: SavedPipelineDbService
) {
    const router = express.Router();
    const base = '/api/connections/:connectionId/databases/:databaseName/collections/:collectionName/pipeline';

    router.post(`${base}/preview`, validateBody(runSchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof runSchema>;

            res.json(
                await pipelineService.previewPipeline(connection, {
                    connectionId: connection.connectionId,
                    databaseName: readParam(req, 'databaseName'),
                    collectionName: readParam(req, 'collectionName'),
                    stages: body.stages as PipelineStage[],
                    upToStageIndex: body.upToStageIndex,
                    sampleSize: body.sampleSize ?? 100,
                    maxTimeMs: body.maxTimeMs,
                })
            );
        } catch (error) {
            sendError(res, error, 'The pipeline preview failed.');
        }
    });

    router.post(`${base}/explain`, validateBody(runSchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof runSchema>;

            res.json(
                await pipelineService.explainPipeline(connection, {
                    connectionId: connection.connectionId,
                    databaseName: readParam(req, 'databaseName'),
                    collectionName: readParam(req, 'collectionName'),
                    stages: body.stages as PipelineStage[],
                    sampleSize: body.sampleSize ?? 100,
                    maxTimeMs: body.maxTimeMs,
                })
            );
        } catch (error) {
            sendError(res, error, 'The pipeline explain failed.');
        }
    });

    /**
     * Runs a pipeline containing a write stage. Reached only from a user gesture,
     * and the service's actor guard enforces that regardless.
     */
    router.post(`${base}/run`, validateBody(runSchema), async (req, res) => {
        const connection = await resolveConnectionParam(req, res, connectionManager);

        if (!connection) {
            return;
        }

        try {
            const body = req.body as z.infer<typeof runSchema>;

            res.json(
                await pipelineService.runWritePipeline(
                    connection,
                    {
                        connectionId: connection.connectionId,
                        databaseName: readParam(req, 'databaseName'),
                        collectionName: readParam(req, 'collectionName'),
                        stages: body.stages as PipelineStage[],
                        sampleSize: body.sampleSize ?? 100,
                        maxTimeMs: body.maxTimeMs,
                    },
                    'user'
                )
            );
        } catch (error) {
            sendError(res, error, 'The pipeline run failed.');
        }
    });

    router.post(`${base}/write-stages`, validateBody(z.object({ stages: z.array(stageSchema) })), (req, res) => {
        const body = req.body as { stages: PipelineStage[]; };
        const writeStages = pipelineService.findWriteStages(body.stages);
        res.json({ hasWriteStage: writeStages.length > 0, writeStages });
    });

    const exportSchema = z.object({
        stages: z.array(stageSchema),
        language: z.enum(['node', 'mongosh', 'python', 'json']),
    });

    router.post(`${base}/export`, validateBody(exportSchema), (req, res) => {
        try {
            const body = req.body as z.infer<typeof exportSchema>;

            res.json({
                language: body.language,
                code: pipelineService.exportPipeline(
                    body.stages as PipelineStage[],
                    readParam(req, 'databaseName'),
                    readParam(req, 'collectionName'),
                    body.language
                ),
            });
        } catch (error) {
            sendError(res, error, 'Could not export the pipeline.');
        }
    });

    /* ---------- Saved pipelines ---------- */

    router.get('/api/saved-pipelines', async (req, res) => {
        try {
            const connectionId = typeof req.query['connectionId'] === 'string' ? req.query['connectionId'] : undefined;

            res.json(
                await savedPipelines.getPipelines(
                    connectionId && ObjectId.isValid(connectionId) ? new ObjectId(connectionId) : undefined,
                    typeof req.query['databaseName'] === 'string' ? req.query['databaseName'] : undefined,
                    typeof req.query['collectionName'] === 'string' ? req.query['collectionName'] : undefined
                )
            );
        } catch (error) {
            sendError(res, error, 'Could not list saved pipelines.');
        }
    });

    const savePipelineSchema = z.object({
        _id: z.string().optional(),
        name: z.string().min(1),
        description: z.string().optional(),
        connectionId: z.string(),
        databaseName: z.string(),
        collectionName: z.string(),
        stages: z.array(stageSchema),
    });

    router.post('/api/saved-pipelines', validateBody(savePipelineSchema), async (req, res) => {
        try {
            const body = req.body as z.infer<typeof savePipelineSchema>;

            res.json(
                await savedPipelines.savePipeline({
                    _id: body._id ? new ObjectId(body._id) : undefined,
                    name: body.name,
                    description: body.description,
                    connectionId: new ObjectId(body.connectionId),
                    databaseName: body.databaseName,
                    collectionName: body.collectionName,
                    stages: body.stages as PipelineStage[],
                })
            );
        } catch (error) {
            sendError(res, error, 'Could not save the pipeline.');
        }
    });

    router.delete('/api/saved-pipelines/:pipelineId', async (req, res) => {
        const pipelineId = readObjectIdParam(req, res, 'pipelineId');

        if (!pipelineId) {
            return;
        }

        try {
            const removed = await savedPipelines.deletePipeline(pipelineId);

            if (!removed) {
                res.status(404).json({ message: 'No such pipeline.' });
                return;
            }

            res.json({ deleted: true });
        } catch (error) {
            sendError(res, error, 'Could not delete the pipeline.');
        }
    });

    return router;
}
