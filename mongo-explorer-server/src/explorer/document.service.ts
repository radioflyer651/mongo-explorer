import { injectable } from 'inversify';
import { Document } from 'mongodb';
import { ExplorerServiceBase } from './explorer-base';
import { LiveConnection } from '../connections/live-connection';
import { OperationActor, assertWriteAllowed } from './operation-actor';
import { ILimitsConfig } from '../model/app-config.model';
import { CollectionRef } from '../model/shared-models/explorer/explorer.model';
import { parseExtendedJson, parseExtendedJsonObject, toExtendedJson } from '../utils/ejson.util';

/** Outcome of a document write. */
export interface WriteOutcome {
    /** Documents matched by the filter. */
    matchedCount: number;

    /** Documents actually changed. */
    modifiedCount: number;

    /** Documents inserted. */
    insertedCount: number;

    /** Documents deleted. */
    deletedCount: number;
}

/**
 * Writes documents to a Target Database.
 *
 * Every method here calls assertWriteAllowed as its first statement. That guard
 * refuses any non-user actor and any read-only connection, below the routes and
 * below the MCP server — which is what makes "an AI cannot write to a Target
 * Database" structural rather than a policy a bug could defeat.
 */
@injectable()
export class DocumentService extends ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        super(limits);
    }

    /** Inserts documents supplied as Extended JSON. */
    async insertDocuments(
        connection: LiveConnection,
        ref: CollectionRef,
        documentsJson: string,
        actor: OperationActor
    ): Promise<WriteOutcome> {
        assertWriteAllowed(connection, actor, 'insertDocuments');

        const parsed = parseExtendedJson<Document | Document[]>(documentsJson, 'documents');
        const documents = Array.isArray(parsed) ? parsed : [parsed];
        const collection = connection.getDatabase(ref.databaseName).collection(ref.collectionName);

        const result = await collection.insertMany(documents);
        return { matchedCount: 0, modifiedCount: 0, insertedCount: result.insertedCount, deletedCount: 0 };
    }

    /** Updates documents matching a filter. */
    async updateDocuments(
        connection: LiveConnection,
        ref: CollectionRef,
        filterJson: string,
        updateJson: string,
        isMany: boolean,
        actor: OperationActor
    ): Promise<WriteOutcome> {
        assertWriteAllowed(connection, actor, 'updateDocuments');

        const filter = parseExtendedJsonObject(filterJson, 'filter');
        const update = parseExtendedJsonObject(updateJson, 'update');
        const collection = connection.getDatabase(ref.databaseName).collection(ref.collectionName);

        const result = isMany
            ? await collection.updateMany(filter, update)
            : await collection.updateOne(filter, update);

        return {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            insertedCount: 0,
            deletedCount: 0,
        };
    }

    /** Replaces a single document wholesale. */
    async replaceDocument(
        connection: LiveConnection,
        ref: CollectionRef,
        filterJson: string,
        replacementJson: string,
        actor: OperationActor
    ): Promise<WriteOutcome> {
        assertWriteAllowed(connection, actor, 'replaceDocument');

        const filter = parseExtendedJsonObject(filterJson, 'filter');
        const replacement = parseExtendedJsonObject(replacementJson, 'replacement');

        /* The identifier is immutable; leaving it in the replacement is an error the
           driver reports confusingly, so remove it here. */
        delete (replacement as Record<string, unknown>)['_id'];

        const collection = connection.getDatabase(ref.databaseName).collection(ref.collectionName);
        const result = await collection.replaceOne(filter, replacement);

        return {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            insertedCount: 0,
            deletedCount: 0,
        };
    }

    /** Deletes documents matching a filter. */
    async deleteDocuments(
        connection: LiveConnection,
        ref: CollectionRef,
        filterJson: string,
        isMany: boolean,
        actor: OperationActor
    ): Promise<WriteOutcome> {
        assertWriteAllowed(connection, actor, 'deleteDocuments');

        const filter = parseExtendedJsonObject(filterJson, 'filter');
        const collection = connection.getDatabase(ref.databaseName).collection(ref.collectionName);

        const result = isMany
            ? await collection.deleteMany(filter)
            : await collection.deleteOne(filter);

        return { matchedCount: 0, modifiedCount: 0, insertedCount: 0, deletedCount: result.deletedCount };
    }

    /**
     * Captures the documents a filter matches, so an operation can be undone.
     * Returns undefined when the affected count exceeds the configured cap, in
     * which case the confirmation must tell the user the change is irreversible.
     */
    async captureSnapshot(
        connection: LiveConnection,
        ref: CollectionRef,
        filterJson: string
    ): Promise<{ snapshotJson?: string; documentCount: number; }> {
        const filter = parseExtendedJsonObject(filterJson, 'filter');
        const collection = connection.getDatabase(ref.databaseName).collection(ref.collectionName);
        const maxTimeMS = this.resolveTimeMs(undefined);

        const count = await collection.countDocuments(filter, { maxTimeMS });

        if (count > this.limits.maxUndoSnapshotDocuments) {
            return { documentCount: count };
        }

        const documents = await collection
            .find(filter, { maxTimeMS })
            .limit(this.limits.maxUndoSnapshotDocuments)
            .toArray();

        return { snapshotJson: toExtendedJson(documents), documentCount: count };
    }
}
