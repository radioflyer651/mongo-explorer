import { randomUUID } from 'crypto';

/**
 * Converts the driver's null for a missed findOne into undefined.
 *
 * Application Database only. Target Database documents keep their nulls: in
 * MongoDB a null value is a real, distinct value and collapsing it into undefined
 * silently rewrites the user's data.
 */
export function nullToUndefined<T>(value: T | null): T | undefined {
    return value === null ? undefined : value;
}

/** Generates a stable identifier for in-memory objects. */
export function newId(): string {
    return randomUUID();
}

/** Current time as an ISO-8601 string. */
export function nowIso(): string {
    return new Date().toISOString();
}

/** Clamps a number into an inclusive range. */
export function clamp(value: number, minimum: number, maximum: number): number {
    if (Number.isNaN(value)) {
        return minimum;
    }

    return Math.min(Math.max(value, minimum), maximum);
}

/** Extracts a message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    return 'Unknown error';
}
