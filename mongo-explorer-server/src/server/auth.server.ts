import express from 'express';
import { z } from 'zod';
import { AuthDbService } from '../database/auth-db.service';
import { signToken } from '../auth/jwt';
import { validateBody } from './middleware/validate-body.middleware';
import { sendError } from './route-helpers';
import { AuthRequirement, LoginResponse } from '../model/shared-models/auth/user.model';

/** Schema for the login body. */
const loginSchema = z.object({
    userName: z.string().min(1, 'A user name is required.'),
    password: z.string(),
});

/**
 * Application authentication routes. Mounted before authMiddleware, because these
 * must be reachable without a token.
 *
 * This is a local lock rather than a security boundary: the application is
 * single-user and bound to loopback, so nothing hostile can reach this port.
 */
export function createAuthRouter(authDbService: AuthDbService, isLoginRequired: boolean, defaultUserName: string) {
    const router = express.Router();

    router.get('/api/auth/requirement', async (_req, res) => {
        try {
            const user = await authDbService.getOrCreateUser(defaultUserName);

            const requirement: AuthRequirement = {
                isLockEnabled: isLoginRequired && user.passwordHash !== undefined,
                userName: user.userName,
            };

            res.json(requirement);
        } catch (error) {
            sendError(res, error, 'Could not read the authentication requirement.');
        }
    });

    router.post('/api/auth/login', validateBody(loginSchema), async (req, res) => {
        try {
            const body = req.body as z.infer<typeof loginSchema>;
            const user = await authDbService.getOrCreateUser(defaultUserName);

            if (user.userName !== body.userName) {
                res.status(401).json({ message: 'Unknown user.' });
                return;
            }

            const isValid = await authDbService.verifyPassword(user, body.password);

            if (!isValid) {
                res.status(401).json({ message: 'Incorrect password.' });
                return;
            }

            await authDbService.recordLogin(user._id);

            const response: LoginResponse = {
                token: signToken(user._id, user.userName),
                userName: user.userName,
            };

            res.json(response);
        } catch (error) {
            sendError(res, error, 'Login failed.');
        }
    });

    return router;
}
