import { BSON, Document } from 'mongodb';

/** Extended JSON codec, taken from the driver's bundled BSON so versions match. */
const EJSON = BSON.EJSON;
import { BsonTypeName, FieldDescriptor, FieldTypeOccurrence } from '../model/shared-models/explorer/bson-type.model';

/**
 * Extended JSON is used at every Target Database boundary. Plain JSON.stringify
 * silently destroys BSON types and would corrupt documents on save.
 */

/** Serialises documents to canonical Extended JSON. */
export function toExtendedJson(value: unknown): string {
    return EJSON.stringify(value, undefined, 0, { relaxed: false });
}

/** Serialises documents to relaxed Extended JSON, for display only. */
export function toRelaxedJson(value: unknown): string {
    return EJSON.stringify(value, undefined, 2, { relaxed: true });
}

/**
 * Parses Extended JSON into BSON values. Throws a descriptive error rather than
 * a bare SyntaxError so the message can reach the user.
 */
export function parseExtendedJson<T = Document>(text: string, label = 'value'): T {
    const trimmed = (text ?? '').trim();

    if (!trimmed) {
        return {} as T;
    }

    try {
        return EJSON.parse(trimmed, { relaxed: false }) as T;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unparseable';
        throw new ExtendedJsonParseError(`Could not parse ${label} as Extended JSON: ${message}`);
    }
}

/** Parses Extended JSON that must yield an object, such as a filter. */
export function parseExtendedJsonObject(text: string, label = 'value'): Document {
    const parsed = parseExtendedJson<unknown>(text, label);

    if (parsed === undefined || parsed === null) {
        return {};
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ExtendedJsonParseError(`Expected ${label} to be an object.`);
    }

    return parsed as Document;
}

/** Parses Extended JSON that must yield an array, such as a pipeline. */
export function parseExtendedJsonArray(text: string, label = 'value'): Document[] {
    const parsed = parseExtendedJson<unknown>(text, label);

    if (!Array.isArray(parsed)) {
        throw new ExtendedJsonParseError(`Expected ${label} to be an array.`);
    }

    return parsed as Document[];
}

/** Raised when Extended JSON supplied by a caller cannot be parsed. */
export class ExtendedJsonParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExtendedJsonParseError';
    }
}

/**
 * Determines the BSON type of a value. Note that null and absent are distinct:
 * in MongoDB a null value is not the same thing as a missing field, and the
 * application must never imply otherwise.
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
        const named = value as { _bsontype?: string; };

        switch (named._bsontype) {
            case 'ObjectId' /* ObjectID in older drivers. */:
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

/**
 * Derives the field list from a set of documents. Columns are a hypothesis about
 * schemaless data, so presence counts are reported and the caller can show how
 * confident the derivation is.
 */
export function deriveFields(documents: readonly Document[], maxDepth = 3): FieldDescriptor[] {
    const accumulator = new Map<string, Map<BsonTypeName, number>>();

    for (const document of documents) {
        collectPaths(document, '', accumulator, maxDepth, 0);
    }

    const sampleSize = documents.length;
    const fields: FieldDescriptor[] = [];

    for (const [path, typeCounts] of accumulator) {
        const types: FieldTypeOccurrence[] = [...typeCounts.entries()]
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count);

        const presentCount = types.reduce((total, occurrence) => total + occurrence.count, 0);

        fields.push({ path, types, presentCount, sampleSize });
    }

    fields.sort((a, b) => b.presentCount - a.presentCount || a.path.localeCompare(b.path));
    return fields;
}

/** Walks a document, recording every field path and the types seen at it. */
function collectPaths(
    value: unknown,
    prefix: string,
    accumulator: Map<string, Map<BsonTypeName, number>>,
    maxDepth: number,
    depth: number
): void {
    if (!isTraversableObject(value) || depth > maxDepth) {
        return;
    }

    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const type = getBsonTypeName(member);

        let typeCounts = accumulator.get(path);
        if (!typeCounts) {
            typeCounts = new Map<BsonTypeName, number>();
            accumulator.set(path, typeCounts);
        }
        typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

        if (type === 'object') {
            collectPaths(member, path, accumulator, maxDepth, depth + 1);
        }
    }
}

/** True when the value is a plain object worth walking into. */
function isTraversableObject(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    if (value instanceof Date || value instanceof RegExp) {
        return false;
    }

    return (value as { _bsontype?: string; })._bsontype === undefined;
}
