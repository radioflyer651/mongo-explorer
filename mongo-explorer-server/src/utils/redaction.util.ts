/**
 * Credential redaction. Every connection string passes through here before any
 * log call. Written early on purpose: retrofitting redaction means auditing every
 * log statement in the codebase.
 */

/** Replacement inserted where a secret was removed. */
const REDACTED = '***REDACTED***';

/** Property names whose values are always removed from logged objects. */
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|credential|passphrase|apikey|api_key|authorization|clientsecret|client_secret|accesstoken|access_token|refreshtoken|refresh_token|jwt|cookie)/i;

/**
 * Removes credentials from a MongoDB connection string, preserving enough shape
 * to remain useful in a log line.
 */
export function redactConnectionString(uri: string): string {
    if (!uri) {
        return uri;
    }

    let result = uri.replace(/(\/\/)([^/@]*)@/, (_match, prefix: string, credentials: string) => {
        const userName = credentials.split(':')[0] ?? '';
        return `${prefix}${userName}:${REDACTED}@`;
    });

    result = result.replace(
        /([?&](?:authMechanismProperties|password|accessToken|tlsCertificateKeyFilePassword)=)([^&]*)/gi,
        `$1${REDACTED}`
    );

    return result;
}

/**
 * Recursively removes sensitive values from an object so it is safe to log.
 * Returns a copy; the input is never modified.
 */
export function redactObject<T>(value: T, depth = 0): unknown {
    if (depth > 12) {
        return '[max depth]';
    }

    if (typeof value === 'string') {
        return looksLikeConnectionString(value) ? redactConnectionString(value) : value;
    }

    if (value === null || typeof value !== 'object') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(item => redactObject(item, depth + 1));
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value instanceof Error) {
        return { name: value.name, message: redactText(value.message) };
    }

    const result: Record<string, unknown> = {};

    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            result[key] = REDACTED;
            continue;
        }

        result[key] = redactObject(member, depth + 1);
    }

    return result;
}

/**
 * Removes anything credential-shaped from free text, for use on driver error
 * messages that are surfaced to the user. Errors must reach the user largely
 * intact — opaque connection errors are the problem this project exists to
 * escape — so this removes secrets and nothing else.
 */
export function redactText(text: string): string {
    if (!text) {
        return text;
    }

    let result = text.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, match => redactConnectionString(match));

    /* Bearer tokens and raw JWTs. */
    result = result.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED);
    result = result.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`);

    return result;
}

/** True when a string looks like a MongoDB connection URI. */
function looksLikeConnectionString(value: string): boolean {
    return /^mongodb(\+srv)?:\/\//i.test(value);
}
