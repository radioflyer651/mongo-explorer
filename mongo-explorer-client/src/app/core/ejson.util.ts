import { EJSON } from 'bson';
import { BsonTypeName } from '../../model/shared-models/explorer/bson-type.model';

/**
 * Extended JSON at the API boundary, on the client as well as the server. Plain
 * JSON.parse would silently destroy BSON types and corrupt documents on save.
 */

/** Parses Extended JSON into BSON values. */
export function parseExtendedJson<T = unknown>(text: string, label = 'value'): T {
    const trimmed = (text ?? '').trim();

    if (!trimmed) {
        return {} as T;
    }

    try {
        return EJSON.parse(trimmed, { relaxed: false }) as T;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unparseable';
        throw new Error(`Could not parse ${label} as Extended JSON: ${message}`);
    }
}

/** Parses a document array returned by the API. */
export function parseDocuments(documentsJson: string): Record<string, unknown>[] {
    const parsed = parseExtendedJson<unknown>(documentsJson, 'documents');
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
}

/** Serialises to canonical Extended JSON, for sending to the API. */
export function toExtendedJson(value: unknown): string {
    return EJSON.stringify(value, undefined, 0, { relaxed: false });
}

/** Serialises to readable relaxed Extended JSON, for display and editing. */
export function toDisplayJson(value: unknown, indent = 2): string {
    return EJSON.stringify(value, undefined, indent, { relaxed: false });
}

/** Reports whether text parses as Extended JSON, for live editor validation. */
export function validateExtendedJson(text: string): { isValid: true; } | { isValid: false; message: string; } {
    const trimmed = (text ?? '').trim();

    if (!trimmed) {
        return { isValid: true };
    }

    try {
        EJSON.parse(trimmed, { relaxed: false });
        return { isValid: true };
    } catch (error) {
        return { isValid: false, message: error instanceof Error ? error.message : 'Unparseable.' };
    }
}

/**
 * Determines a value's BSON type.
 *
 * null and absent are deliberately distinct: in MongoDB a null value is not the same
 * thing as a missing field, and the interface must never imply otherwise.
 */
export function getBsonTypeName(value: unknown): BsonTypeName {
    if (value === undefined) {
        return 'absent';
    }

    if (value === null) {
        return 'null';
    }

    if (typeof value === 'string') {
        return 'string';
    }

    if (typeof value === 'boolean') {
        return 'bool';
    }

    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'int' : 'double';
    }

    if (typeof value === 'bigint') {
        return 'long';
    }

    if (value instanceof Date) {
        return 'date';
    }

    if (value instanceof RegExp) {
        return 'regex';
    }

    if (Array.isArray(value)) {
        return 'array';
    }

    if (typeof value === 'object') {
        switch ((value as { _bsontype?: string; })._bsontype) {
            case 'ObjectId':
            case 'ObjectID':
                return 'objectId';
            case 'Decimal128':
                return 'decimal';
            case 'Long':
                return 'long';
            case 'Int32':
                return 'int';
            case 'Double':
                return 'double';
            case 'Binary':
                return 'binData';
            case 'UUID':
                return 'binData';
            case 'Timestamp':
                return 'timestamp';
            case 'MinKey':
                return 'minKey';
            case 'MaxKey':
                return 'maxKey';
            case 'BSONRegExp':
                return 'regex';
            case 'Code':
                return 'javascript';
            default:
                return 'object';
        }
    }

    return 'unknown';
}

/** Reads a nested value by dotted path, distinguishing absent from null. */
export function readPath(document: Record<string, unknown>, path: string): unknown {
    const segments = path.split('.');
    let current: unknown = document;

    for (const segment of segments) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }

        if (!(segment in (current as Record<string, unknown>))) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[segment];
    }

    return current;
}

/** A short, safe display string for a value, for grid cells and summaries. */
export function summariseValue(value: unknown, type: BsonTypeName): string {
    switch (type) {
        case 'absent':
            return '';
        case 'null':
            return 'null';
        case 'objectId':
            return String(value);
        case 'date':
            return value instanceof Date ? value.toISOString() : String(value);
        case 'binData':
            return '(binary)';
        case 'array':
            return `[${Array.isArray(value) ? value.length : 0}]`;
        case 'object':
            return `{${Object.keys((value as Record<string, unknown>) ?? {}).length}}`;
        default:
            return String(value);
    }
}

/** The CSS custom property holding a type's colour. */
export function bsonTypeColorVariable(type: BsonTypeName): string {
    switch (type) {
        case 'objectId':
            return '--color-bson-objectid';
        case 'string':
            return '--color-bson-string';
        case 'int':
        case 'long':
        case 'double':
        case 'decimal':
            return '--color-bson-number';
        case 'bool':
            return '--color-bson-boolean';
        case 'date':
        case 'timestamp':
            return '--color-bson-date';
        case 'null':
            return '--color-bson-null';
        case 'absent':
            return '--color-bson-absent';
        case 'binData':
            return '--color-bson-binary';
        case 'array':
            return '--color-bson-array';
        default:
            return '--color-bson-object';
    }
}
