import express from 'express';
import { z } from 'zod';
import { McpModeService } from '../mcp/mcp-mode.service';
import { AppSessionService } from '../mcp/app-session.service';
import { ProposalService } from '../mcp/proposal.service';
import { ActivityService } from '../mcp/activity.service';
import { validateBody } from './middleware/validate-body.middleware';
import { readParam, sendError } from './route-helpers';
import { MCP_MODE_CAPABILITIES, McpMode } from '../model/shared-models/mcp/mcp-mode.model';

/**
 * Routes backing the AI mode switch, the Proposals panel, and the activity log.
 *
 * Note what is here and what is not: the user can change the mode and apply a
 * proposal through these routes. The MCP server cannot reach either — it has no tool
 * that changes the mode, and no tool that applies a proposal.
 */
export function createAiRouter(
    modeService: McpModeService,
    sessionService: AppSessionService,
    proposalService: ProposalService,
    activityService: ActivityService
) {
    const router = express.Router();

    router.get('/api/ai/mode', (_req, res) => {
        res.json({
            mode: modeService.currentMode,
            capabilities: modeService.capabilities,
            allModes: MCP_MODE_CAPABILITIES,
        });
    });

    router.post('/api/ai/mode', validateBody(z.object({ mode: z.nativeEnum(McpMode) })), async (req, res) => {
        try {
            const body = req.body as { mode: McpMode; };
            await modeService.setMode(body.mode, 'Changed by the user.');

            activityService.record({
                actor: 'user',
                action: 'ai.setMode',
                description: `Set the AI mode to ${body.mode}`,
            });

            res.json({ mode: modeService.currentMode, capabilities: modeService.capabilities });
        } catch (error) {
            sendError(res, error, 'Could not change the AI mode.');
        }
    });

    router.get('/api/ai/session-state', (_req, res) => {
        res.json(sessionService.getState());
    });

    router.get('/api/ai/proposals', (_req, res) => {
        res.json(proposalService.getAll());
    });

    router.get('/api/ai/proposals/:proposalId', (req, res) => {
        const proposal = proposalService.getProposal(readParam(req, 'proposalId'));

        if (!proposal) {
            res.status(404).json({ message: 'No such proposal.' });
            return;
        }

        res.json(proposal);
    });

    /**
     * Applies a proposal. This is the user pressing the button: the operation runs
     * with actor 'user' because a human decided to run it.
     */
    router.post('/api/ai/proposals/:proposalId/apply', async (req, res) => {
        try {
            const result = await proposalService.applyProposal(readParam(req, 'proposalId'));

            activityService.record({
                actor: 'user',
                action: 'proposal.apply',
                description: result.succeeded
                    ? `Applied proposal ${readParam(req, 'proposalId')}`
                    : `Failed to apply proposal ${readParam(req, 'proposalId')}`,
            });

            res.status(result.succeeded ? 200 : 400).json(result);
        } catch (error) {
            sendError(res, error, 'Could not apply the proposal.');
        }
    });

    router.post('/api/ai/proposals/:proposalId/reject', (req, res) => {
        const rejected = proposalService.rejectProposal(readParam(req, 'proposalId'));

        if (!rejected) {
            res.status(404).json({ message: 'No such pending proposal.' });
            return;
        }

        activityService.record({
            actor: 'user',
            action: 'proposal.reject',
            description: `Rejected proposal ${readParam(req, 'proposalId')}`,
        });

        res.json({ rejected: true });
    });

    router.get('/api/ai/activity', (req, res) => {
        const limit = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : 100;
        res.json(activityService.getRecent(Number.isNaN(limit) ? 100 : limit));
    });

    router.get('/api/ai/activity/last-undoable', (_req, res) => {
        const entry = activityService.getLastUndoableAiEntry();

        if (!entry) {
            res.status(404).json({ message: 'There is nothing to undo.' });
            return;
        }

        res.json(entry);
    });

    router.post('/api/ai/activity/:entryId/undone', (req, res) => {
        activityService.markUndone(readParam(req, 'entryId'));
        res.json({ marked: true });
    });

    return router;
}
