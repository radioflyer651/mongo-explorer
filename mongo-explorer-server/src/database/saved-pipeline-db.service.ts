import { injectable } from 'inversify';
import { ObjectId } from 'mongodb';
import { DbService } from './db-service';
import { MongoHelper } from '../mongo-helper';
import { DbCollectionNames } from '../model/db-collection-names.constants';
import { SavedPipeline } from '../model/shared-models/explorer/pipeline.model';
import { nowIso } from '../utils/misc.util';

/** Stores aggregation pipelines in the Application Database for reuse. */
@injectable()
export class SavedPipelineDbService extends DbService {
    constructor(dbHelper: MongoHelper) {
        super(dbHelper);
    }

    /** Returns saved pipelines, optionally narrowed to one collection. */
    async getPipelines(connectionId?: ObjectId, databaseName?: string, collectionName?: string): Promise<SavedPipeline[]> {
        const filter: Record<string, unknown> = {};

        if (connectionId) {
            filter['connectionId'] = connectionId;
        }

        if (databaseName) {
            filter['databaseName'] = databaseName;
        }

        if (collectionName) {
            filter['collectionName'] = collectionName;
        }

        const found = await this.dbHelper.findDataItem<SavedPipeline>(
            DbCollectionNames.SavedPipelines,
            filter,
            { sort: { name: 1 } }
        );

        return found as SavedPipeline[];
    }

    /** Returns one saved pipeline. */
    async getPipelineById(pipelineId: ObjectId): Promise<SavedPipeline | undefined> {
        const found = await this.dbHelper.findDataItem<SavedPipeline>(
            DbCollectionNames.SavedPipelines,
            { _id: pipelineId },
            { findOne: true }
        );

        return found as SavedPipeline | undefined;
    }

    /** Creates or updates a saved pipeline. */
    async savePipeline(pipeline: Omit<SavedPipeline, '_id' | 'createdAt' | 'updatedAt'> & { _id?: ObjectId; }): Promise<SavedPipeline> {
        const existing = pipeline._id ? await this.getPipelineById(pipeline._id) : undefined;

        const record: SavedPipeline = {
            _id: pipeline._id ?? new ObjectId(),
            name: pipeline.name,
            description: pipeline.description,
            connectionId: pipeline.connectionId,
            databaseName: pipeline.databaseName,
            collectionName: pipeline.collectionName,
            stages: pipeline.stages,
            createdAt: existing?.createdAt ?? nowIso(),
            updatedAt: nowIso(),
        };

        await this.dbHelper.upsertDataItem(DbCollectionNames.SavedPipelines, record);
        return record;
    }

    /** Deletes a saved pipeline. */
    async deletePipeline(pipelineId: ObjectId): Promise<boolean> {
        const removed = await this.dbHelper.deleteDataItems<SavedPipeline>(
            DbCollectionNames.SavedPipelines,
            { _id: pipelineId }
        );

        return removed > 0;
    }
}
