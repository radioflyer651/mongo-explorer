import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { ConnectionManager } from '../connections/connection-manager.service';
import { LiveConnection, ConnectionNotUsableError, ReadOnlyConnectionError } from '../connections/live-connection';
import { ConnectionStrategyError } from '../connections/connection-strategy';
import { ForbiddenActorError } from '../explorer/operation-actor';
import { ExtendedJsonParseError } from '../utils/ejson.util';
import { WriteStagePresentError } from '../explorer/pipeline.service';
import { errorMessage } from '../utils/misc.util';
import { redactText } from '../utils/redaction.util';

/**
 * Maps a thrown error onto an HTTP status and a message.
 *
 * Driver errors reach the user largely intact, minus secrets: opaque connection
 * errors are the problem this project exists to escape, so reproducing them here
 * would be self-defeating.
 */
export function sendError(res: Response, error: unknown, fallbackMessage: string): void {
    const message = redactText(errorMessage(error)) || fallbackMessage;

    if (error instanceof ExtendedJsonParseError) {
        res.status(400).json({ message });
        return;
    }

    if (error instanceof ForbiddenActorError) {
        res.status(403).json({ message, code: 'forbidden_actor' });
        return;
    }

    if (error instanceof ReadOnlyConnectionError) {
        res.status(403).json({ message, code: 'read_only_connection' });
        return;
    }

    if (error instanceof WriteStagePresentError) {
        res.status(400).json({ message, code: 'write_stage_present', stages: error.stages });
        return;
    }

    if (error instanceof ConnectionNotUsableError) {
        res.status(409).json({ message, code: 'not_connected', state: error.state });
        return;
    }

    if (error instanceof ConnectionStrategyError) {
        res.status(error.isConfigurationProblem ? 400 : 502).json({ message, code: 'connection_failed' });
        return;
    }

    res.status(500).json({ message });
}

/**
 * Reads a route parameter as a single string.
 *
 * Express types parameters as string or string array because a pattern can repeat.
 * None of this application's routes do, so collapsing to the first value is correct
 * and keeps every call site from restating it.
 */
export function readParam(req: Request, name: string): string {
    const value = req.params[name];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Reads and validates an ObjectId route parameter. */
export function readObjectIdParam(req: Request, res: Response, name: string): ObjectId | undefined {
    const raw = readParam(req, name);

    if (!raw || !ObjectId.isValid(raw)) {
        res.status(400).json({ message: `'${name}' must be a 24-character hex identifier.` });
        return undefined;
    }

    return new ObjectId(raw);
}

/** Opens the connection named by a route parameter, or replies with an error. */
export async function resolveConnectionParam(
    req: Request,
    res: Response,
    connectionManager: ConnectionManager,
    paramName = 'connectionId'
): Promise<LiveConnection | undefined> {
    const connectionId = readObjectIdParam(req, res, paramName);

    if (!connectionId) {
        return undefined;
    }

    try {
        return await connectionManager.getConnection(connectionId);
    } catch (error) {
        sendError(res, error, 'The connection could not be opened.');
        return undefined;
    }
}

/** Reads a required string query parameter. */
export function readStringQuery(req: Request, name: string): string | undefined {
    const value = req.query[name];
    return typeof value === 'string' ? value : undefined;
}

/** Reads a numeric query parameter. */
export function readNumberQuery(req: Request, name: string): number | undefined {
    const value = req.query[name];

    if (typeof value !== 'string') {
        return undefined;
    }

    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}
