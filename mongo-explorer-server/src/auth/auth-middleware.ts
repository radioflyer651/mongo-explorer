import { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { TokenPayload } from '../model/shared-models/auth/token-payload.model';
import { verifyToken } from './jwt';

/** The identifier used when no login is required. */
let anonymousPayload: TokenPayload | undefined;

/**
 * Configures the identity used when the local lock is disabled.
 *
 * The application is single-user and loopback-only, so a login is a local lock
 * rather than a security boundary. When it is off, every request runs as the single
 * user and route signatures stay uniform.
 */
export function configureAnonymousUser(userId: ObjectId, userName: string): void {
    anonymousPayload = { userId, userName };
}

/** Whether a login is required for this installation. */
let loginRequired = false;

/** Sets whether the local lock is enabled. */
export function configureLoginRequirement(isRequired: boolean): void {
    loginRequired = isRequired;
}

/**
 * Verifies the application JWT. This is application authentication — "who is using
 * Mongo Explorer" — and is entirely separate from Target Database authentication.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!loginRequired && anonymousPayload) {
        (req as Request & { user?: TokenPayload; }).user = anonymousPayload;
        next();
        return;
    }

    const token = req.headers['authorization'] as string | undefined;

    if (!token) {
        res.status(401).json({ message: 'Access denied. No token provided.' });
        return;
    }

    const decoded = await verifyToken(token);

    if (!decoded) {
        res.status(401).json({ message: 'Invalid token.' });
        return;
    }

    (req as Request & { user?: TokenPayload; }).user = decoded;
    next();
}

/** Reads the acting user's identifier from a request. */
export function getUserIdFromRequest(req: Request): ObjectId | undefined {
    return (req as Request & { user?: TokenPayload; }).user?.userId;
}
