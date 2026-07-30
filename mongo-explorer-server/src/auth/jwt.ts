import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { TokenPayload } from '../model/shared-models/auth/token-payload.model';

let signingSecret = 'uninitialised';
let tokenExpiry = '30d';

/** Configures the signing secret. Called once during start-up. */
export function configureJwt(secret: string, expiry: string): void {
    signingSecret = secret;
    tokenExpiry = expiry;
}

/** Signs a token for the application user. */
export function signToken(userId: ObjectId, userName: string): string {
    return jwt.sign({ userId: userId.toHexString(), userName }, signingSecret, {
        expiresIn: tokenExpiry,
    } as jwt.SignOptions);
}

/** Verifies a token, returning its payload or undefined when it is not valid. */
export async function verifyToken(token: string): Promise<TokenPayload | undefined> {
    try {
        const decoded = jwt.verify(stripBearer(token), signingSecret) as Record<string, unknown>;

        if (typeof decoded['userId'] !== 'string') {
            return undefined;
        }

        return {
            userId: new ObjectId(decoded['userId']),
            userName: String(decoded['userName'] ?? 'user'),
            iat: typeof decoded['iat'] === 'number' ? decoded['iat'] : undefined,
            exp: typeof decoded['exp'] === 'number' ? decoded['exp'] : undefined,
        };
    } catch {
        return undefined;
    }
}

/**
 * Removes a Bearer prefix when present. This codebase sends the raw JWT, but
 * tolerating the prefix costs nothing and avoids a confusing failure when
 * interoperating.
 */
function stripBearer(token: string): string {
    return token.startsWith('Bearer ') ? token.slice(7) : token;
}
