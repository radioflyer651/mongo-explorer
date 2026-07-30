import { injectable } from 'inversify';
import { Document } from 'mongodb';
import { ExplorerServiceBase } from './explorer-base';
import { LiveConnection } from '../connections/live-connection';
import { OperationActor, assertWriteAllowed } from './operation-actor';
import { summariseExplain } from './query.service';
import { ILimitsConfig } from '../model/app-config.model';
import {
    PipelineExplainResult,
    PipelineExportLanguage,
    PipelinePreviewResult,
    PipelineRunRequest,
    PipelineStage,
    PipelineStageNote,
    WRITE_PIPELINE_STAGES,
} from '../model/shared-models/explorer/pipeline.model';
import { deriveFields, parseExtendedJsonObject, toExtendedJson, toRelaxedJson } from '../utils/ejson.util';

/** Raised when a pipeline containing a write stage is submitted for execution. */
export class WriteStagePresentError extends Error {
    constructor(readonly stages: string[]) {
        super(
            `This pipeline contains write stage${stages.length > 1 ? 's' : ''} ${stages.join(', ')}, ` +
            'which writes to a collection. Preview and explain are refused for write pipelines; ' +
            'the user must execute it explicitly.'
        );
        this.name = 'WriteStagePresentError';
    }
}

/**
 * Aggregation pipeline execution, preview, explain, and code generation.
 *
 * The stage-addressable model is what makes this tool useful: previewing the prefix
 * up to stage N turns pipeline authoring from guesswork into iteration.
 */
@injectable()
export class PipelineService extends ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        super(limits);
    }

    /**
     * Detects write stages structurally, on the parsed pipeline rather than by
     * string matching. A pipeline containing $out or $merge is a data mutation
     * wearing read-only clothing, and is the most likely accidental bypass of the
     * whole safety model.
     */
    findWriteStages(stages: readonly PipelineStage[]): string[] {
        const found: string[] = [];

        for (const stage of stages) {
            if (!stage.isEnabled) {
                continue;
            }

            const operator = stage.operator?.trim();

            if (operator && WRITE_PIPELINE_STAGES.includes(operator)) {
                found.push(operator);
                continue;
            }

            /* A stage body can also carry the operator, when authored as text. */
            try {
                const parsed = this.parseStage(stage);

                for (const key of Object.keys(parsed)) {
                    if (WRITE_PIPELINE_STAGES.includes(key)) {
                        found.push(key);
                    }
                }
            } catch {
                /* An unparseable stage is reported by the caller, not here. */
            }
        }

        return [...new Set(found)];
    }

    /**
     * Runs a bounded preview of a pipeline prefix. Always labelled as a preview: a
     * preview count is never a result count.
     */
    async previewPipeline(connection: LiveConnection, request: PipelineRunRequest): Promise<PipelinePreviewResult> {
        const enabled = request.stages.filter(stage => stage.isEnabled);
        const writeStages = this.findWriteStages(enabled);

        if (writeStages.length) {
            throw new WriteStagePresentError(writeStages);
        }

        const lastIndex = request.upToStageIndex ?? enabled.length - 1;
        const prefix = enabled.slice(0, Math.max(0, lastIndex + 1));
        const sampleSize = this.resolveSampleSize(request.sampleSize, this.limits.pipelinePreviewSize);
        const maxTimeMS = this.resolveTimeMs(request.maxTimeMs);

        const built = prefix.map(stage => this.parseStage(stage));
        built.push({ $limit: sampleSize });

        const collection = connection.getDatabase(request.databaseName).collection(request.collectionName);
        const startedAt = Date.now();

        let documents: Document[] = [];
        let isPartial = false;

        try {
            documents = await collection.aggregate(built, { maxTimeMS, allowDiskUse: false }).toArray();
        } catch (error) {
            if (!this.isTimeoutError(error)) {
                throw error;
            }

            isPartial = true;
        }

        return {
            documentsJson: toExtendedJson(documents),
            returnedCount: documents.length,
            appliedSampleSize: sampleSize,
            isPreview: true,
            isPartial: isPartial || documents.length >= sampleSize,
            lastStageIndex: prefix.length - 1,
            durationMs: Date.now() - startedAt,
            fields: deriveFields(documents),
        };
    }

    /** Explains a pipeline, extracting per-stage index usage. */
    async explainPipeline(connection: LiveConnection, request: PipelineRunRequest): Promise<PipelineExplainResult> {
        const enabled = request.stages.filter(stage => stage.isEnabled);
        const writeStages = this.findWriteStages(enabled);

        if (writeStages.length) {
            throw new WriteStagePresentError(writeStages);
        }

        const built = enabled.map(stage => this.parseStage(stage));
        const collection = connection.getDatabase(request.databaseName).collection(request.collectionName);

        const plan = (await collection
            .aggregate(built, { maxTimeMS: this.resolveTimeMs(request.maxTimeMs) })
            .explain('queryPlanner')) as Document;

        const summary = summariseExplain(plan);
        const notes: PipelineStageNote[] = enabled.map((stage, index) => ({
            stageIndex: index,
            operator: stage.operator,
            usesIndex: index === 0 && !summary.isCollectionScan,
            note: index === 0 && summary.isCollectionScan
                ? 'This stage caused a full collection scan. An index on the filtered fields would help.'
                : undefined,
        }));

        return { ...summary, stageNotes: notes };
    }

    /**
     * Executes a pipeline containing a write stage. Reachable only from a user
     * gesture: the actor guard refuses anything else.
     */
    async runWritePipeline(
        connection: LiveConnection,
        request: PipelineRunRequest,
        actor: OperationActor
    ): Promise<{ durationMs: number; }> {
        assertWriteAllowed(connection, actor, 'runWritePipeline');

        const enabled = request.stages.filter(stage => stage.isEnabled);
        const built = enabled.map(stage => this.parseStage(stage));
        const collection = connection.getDatabase(request.databaseName).collection(request.collectionName);
        const startedAt = Date.now();

        /* A write pipeline returns no documents; draining the cursor runs it. */
        await collection.aggregate(built, { maxTimeMS: this.resolveTimeMs(request.maxTimeMs) }).toArray();
        return { durationMs: Date.now() - startedAt };
    }

    /** Generates runnable code for a pipeline. */
    exportPipeline(
        stages: readonly PipelineStage[],
        databaseName: string,
        collectionName: string,
        language: PipelineExportLanguage
    ): string {
        const enabled = stages.filter(stage => stage.isEnabled);
        const parsed = enabled.map(stage => this.parseStage(stage));
        const pretty = toRelaxedJson(parsed);

        switch (language) {
            case 'mongosh':
                return `use ${databaseName};\n\ndb.getCollection(${JSON.stringify(collectionName)}).aggregate(\n${indent(pretty)}\n);`;

            case 'node':
                return [
                    "const { MongoClient } = require('mongodb');",
                    '',
                    'const pipeline =',
                    `${indent(pretty)};`,
                    '',
                    'async function run(client) {',
                    `    const collection = client.db(${JSON.stringify(databaseName)}).collection(${JSON.stringify(collectionName)});`,
                    '    const results = await collection.aggregate(pipeline).toArray();',
                    '    console.log(results);',
                    '}',
                ].join('\n');

            case 'python':
                return [
                    'from pymongo import MongoClient',
                    '',
                    'pipeline = ',
                    indent(pretty),
                    '',
                    'def run(client):',
                    `    collection = client[${JSON.stringify(databaseName)}][${JSON.stringify(collectionName)}]`,
                    '    for document in collection.aggregate(pipeline):',
                    '        print(document)',
                ].join('\n');

            case 'json':
            default:
                return pretty;
        }
    }

    /**
     * Turns a builder stage into a driver stage document. A stage body may either
     * include its operator or omit it, so both forms are accepted.
     */
    private parseStage(stage: PipelineStage): Document {
        const body = (stage.body ?? '').trim();
        const operator = stage.operator?.trim();

        if (!body) {
            throw new Error(`Stage ${operator || '(unnamed)'} has an empty body.`);
        }

        const parsed = parseExtendedJsonObject(body, `stage ${operator || '(unnamed)'}`);
        const keys = Object.keys(parsed);

        if (keys.length === 1 && keys[0].startsWith('$')) {
            return parsed;
        }

        if (!operator) {
            throw new Error('A stage must either name an operator or contain one in its body.');
        }

        return { [operator]: parsed } as Document;
    }
}

/** Indents a block of text by four spaces. */
function indent(text: string): string {
    return text
        .split('\n')
        .map(line => `    ${line}`)
        .join('\n');
}
