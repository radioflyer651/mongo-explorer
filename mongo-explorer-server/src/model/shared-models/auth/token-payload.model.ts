import { ObjectId } from 'mongodb';

/** Decoded contents of the application JWT. */
export interface TokenPayload {
    /** Identifier of the application user. */
    userId: ObjectId;

    /** Login name of the application user. */
    userName: string;

    /** Issued-at time, in seconds since the epoch. */
    iat?: number;

    /** Expiry time, in seconds since the epoch. */
    exp?: number;
}
