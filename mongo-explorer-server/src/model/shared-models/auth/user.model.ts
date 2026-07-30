import { ObjectId } from 'mongodb';

/**
 * The single application user. Mongo Explorer is single-user by design, so this
 * exists to hold the local lock credential and preferences rather than to
 * support multi-tenancy.
 */
export interface AppUser {
    /** Identifier in the Application Database. */
    _id: ObjectId;

    /** Login name. Defaults to the operating-system user name on first run. */
    userName: string;

    /** Bcrypt hash of the local lock password, absent when no lock is set. */
    passwordHash?: string;

    /** When the account record was created, as an ISO-8601 string. */
    createdAt: string;

    /** When the user last authenticated, as an ISO-8601 string. */
    lastLoginAt?: string;
}

/** Request body for the login endpoint. */
export interface LoginRequest {
    /** Login name. */
    userName: string;

    /** Plain-text password, only ever sent over loopback. */
    password: string;
}

/** Successful login response. */
export interface LoginResponse {
    /** Raw JWT, sent without a Bearer prefix per the project convention. */
    token: string;

    /** The authenticated user's name. */
    userName: string;
}

/** Describes whether the application requires a login at all. */
export interface AuthRequirement {
    /** True when a local lock password has been configured. */
    isLockEnabled: boolean;

    /** The user name to pre-fill on the login form. */
    userName: string;
}
