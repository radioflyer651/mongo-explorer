import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ComponentBase } from '../../component-base/component-base.component';
import { WorkspaceService } from '../../../services/workspace.service';
import { ConnectionStateService } from '../../../services/connection-state.service';
import { ClientApiService } from '../../../services/explorer/api-clients/client-api.service';
import { parseDocuments, toDisplayJson, validateExtendedJson } from '../../../core/ejson.util';
import { PipelineStage } from '../../../../model/shared-models/explorer/pipeline.model';

/** Operators offered by the stage palette. */
interface PaletteEntry {
    /** Operator name including the dollar sign. */
    operator: string;

    /** One-line description. */
    description: string;

    /** Insertable skeleton body. */
    skeleton: string;
}

/** Counter for minting stage identifiers. */
let stageCounter = 0;

/**
 * The aggregation pipeline builder.
 *
 * Stages are addressable, so editing stage four leaves the user's work on the others
 * intact. Per-stage preview is the feature that turns pipeline authoring from
 * guesswork into iteration.
 */
@Component({
    selector: 'app-pipeline-builder',
    imports: [CommonModule, FormsModule],
    templateUrl: './pipeline-builder.component.html',
    styleUrl: './pipeline-builder.component.scss',
})
export class PipelineBuilderComponent extends ComponentBase {
    constructor(readonly workspace: WorkspaceService) {
        super();
    }

    private readonly api = inject(ClientApiService);
    private readonly connections = inject(ConnectionStateService);

    /** The stage palette. Discovery matters more here than anywhere else. */
    readonly palette: readonly PaletteEntry[] = [
        { operator: '$match', description: 'Keep only documents matching a filter.', skeleton: '{ "field": "value" }' },
        { operator: '$group', description: 'Group documents and accumulate values.', skeleton: '{ "_id": "$field", "count": { "$sum": 1 } }' },
        { operator: '$sort', description: 'Order the documents.', skeleton: '{ "field": -1 }' },
        { operator: '$project', description: 'Choose or compute the fields to keep.', skeleton: '{ "field": 1 }' },
        { operator: '$limit', description: 'Keep only the first N documents.', skeleton: '10' },
        { operator: '$skip', description: 'Discard the first N documents.', skeleton: '0' },
        { operator: '$unwind', description: 'Expand an array into one document per element.', skeleton: '"$arrayField"' },
        { operator: '$lookup', description: 'Join documents from another collection.', skeleton: '{ "from": "other", "localField": "id", "foreignField": "_id", "as": "joined" }' },
        { operator: '$addFields', description: 'Add computed fields, keeping the rest.', skeleton: '{ "computed": { "$toUpper": "$field" } }' },
        { operator: '$count', description: 'Replace the output with a single count.', skeleton: '"total"' },
        { operator: '$sample', description: 'Take a random sample.', skeleton: '{ "size": 10 }' },
        { operator: '$facet', description: 'Run several sub-pipelines at once.', skeleton: '{ "byKind": [ { "$sortByCount": "$kind" } ] }' },
        { operator: '$out', description: 'WRITES: replace a collection with the output.', skeleton: '"targetCollection"' },
        { operator: '$merge', description: 'WRITES: merge the output into a collection.', skeleton: '{ "into": "targetCollection" }' },
    ];

    /** Sample size for previews. */
    readonly sampleSize = signal(100);

    /** Which stage's output is previewed. */
    readonly previewStageIndex = signal<number | undefined>(undefined);

    /** The preview result documents. */
    readonly previewDocuments = signal<Record<string, unknown>[]>([]);

    /** Whether a preview is running. */
    readonly isPreviewing = signal(false);

    /** The most recent preview error. */
    readonly previewError = signal<string | undefined>(undefined);

    /** Whether the preview output was truncated. */
    readonly previewTruncated = signal(false);

    /** Whether the palette is showing. */
    readonly isPaletteOpen = signal(false);

    /** Generated code, when the user has exported. */
    readonly exportedCode = signal<string | undefined>(undefined);

    /** The focused tab. */
    readonly tab = computed(() => this.workspace.activeTab());

    /** The pipeline stages. */
    readonly stages = computed(() => this.tab()?.pipelineStages ?? []);

    /** Write stages present in the pipeline, detected on the operator. */
    readonly writeStages = computed(() =>
        this.stages()
            .filter(stage => stage.isEnabled && ['$out', '$merge'].includes(stage.operator.trim()))
            .map(stage => stage.operator.trim())
    );

    /**
     * Whether the pipeline writes. Such a pipeline cannot be previewed or explained,
     * and only the user can run it.
     */
    readonly hasWriteStage = computed(() => this.writeStages().length > 0);

    /** Whether the connection forbids writes. */
    readonly isReadOnly = computed(() => {
        const connectionId = this.tab()?.connectionId;
        return connectionId ? (this.connections.statusFor(connectionId)?.isReadOnly ?? false) : true;
    });

    /** Per-stage validation messages, keyed by stage id. */
    readonly stageErrors = computed(() => {
        const errors: Record<string, string> = {};

        for (const stage of this.stages()) {
            const validation = validateExtendedJson(stage.body);

            if (!validation.isValid) {
                errors[stage.id] = validation.message;
            }
        }

        return errors;
    });

    /** Adds a stage from the palette. */
    addStage(entry: PaletteEntry): void {
        stageCounter += 1;

        const stage: PipelineStage = {
            id: `stage-${stageCounter}`,
            operator: entry.operator,
            body: entry.skeleton,
            isEnabled: true,
        };

        this.workspace.updateActiveTab(tab => ({
            ...tab,
            pipelineStages: [...tab.pipelineStages, stage],
            isPipelineDirty: true,
        }));

        this.isPaletteOpen.set(false);
    }

    /** Rewrites one stage's body. */
    setStageBody(index: number, body: string): void {
        this.workspace.updateActiveTab(tab => {
            const stages = [...tab.pipelineStages];
            stages[index] = { ...stages[index], body };
            return { ...tab, pipelineStages: stages, isPipelineDirty: true };
        });
    }

    /**
     * Enables or disables a stage without deleting it. Bisecting a broken pipeline
     * this way is the normal debugging method and it does not lose work.
     */
    toggleStage(index: number): void {
        this.workspace.updateActiveTab(tab => {
            const stages = [...tab.pipelineStages];
            stages[index] = { ...stages[index], isEnabled: !stages[index].isEnabled };
            return { ...tab, pipelineStages: stages, isPipelineDirty: true };
        });
    }

    /** Deletes one stage. */
    removeStage(index: number): void {
        this.workspace.updateActiveTab(tab => ({
            ...tab,
            pipelineStages: tab.pipelineStages.filter((_, candidate) => candidate !== index),
            isPipelineDirty: true,
        }));
    }

    /** Moves a stage up or down. */
    moveStage(index: number, delta: number): void {
        this.workspace.updateActiveTab(tab => {
            const target = index + delta;

            if (target < 0 || target >= tab.pipelineStages.length) {
                return tab;
            }

            const stages = [...tab.pipelineStages];
            const [moved] = stages.splice(index, 1);
            stages.splice(target, 0, moved);

            return { ...tab, pipelineStages: stages, isPipelineDirty: true };
        });
    }

    /**
     * Previews the pipeline prefix up to one stage. Always a preview: its count is
     * never a result count.
     */
    async preview(upToStageIndex?: number): Promise<void> {
        const tab = this.tab();

        if (!tab?.connectionId || !tab.databaseName || !tab.collectionName) {
            return;
        }

        if (this.hasWriteStage()) {
            this.previewError.set(
                `This pipeline contains ${this.writeStages().join(' and ')}, which writes to a collection. ` +
                'A write pipeline cannot be previewed — only run deliberately.'
            );
            return;
        }

        this.isPreviewing.set(true);
        this.previewError.set(undefined);
        this.previewStageIndex.set(upToStageIndex);

        try {
            const result = await firstValueFrom(
                this.api.previewPipeline(
                    tab.connectionId,
                    tab.databaseName,
                    tab.collectionName,
                    this.stages().filter(stage => stage.isEnabled),
                    upToStageIndex,
                    this.sampleSize()
                )
            );

            this.previewDocuments.set(parseDocuments(result.documentsJson));
            this.previewTruncated.set(result.isPartial);
        } catch (error) {
            this.previewError.set(this.describe(error));
            this.previewDocuments.set([]);
        } finally {
            this.isPreviewing.set(false);
        }
    }

    /** Runs a write pipeline. Only reachable by explicit user action. */
    async runWritePipeline(): Promise<void> {
        const tab = this.tab();

        if (!tab?.connectionId || !tab.databaseName || !tab.collectionName || !this.hasWriteStage()) {
            return;
        }

        /* The button carries a disabled class for this, but a class stops nothing.
           A read-only connection must refuse before the request is even built. */
        if (this.isReadOnly()) {
            this.previewError.set('This connection is marked read-only, so the pipeline was not run.');
            return;
        }

        const confirmed = window.confirm(
            `This pipeline uses ${this.writeStages().join(' and ')} and will write to a collection. ` +
            'This cannot be undone. Continue?'
        );

        if (!confirmed) {
            return;
        }

        this.previewError.set(undefined);

        try {
            await firstValueFrom(
                this.api.runWritePipeline(
                    tab.connectionId,
                    tab.databaseName,
                    tab.collectionName,
                    this.stages().filter(stage => stage.isEnabled)
                )
            );

            this.workspace.updateActiveTab(current => ({ ...current, isPipelineDirty: false }));
        } catch (error) {
            this.previewError.set(this.describe(error));
        }
    }

    /** Generates code for the pipeline. */
    async exportAs(language: 'node' | 'mongosh' | 'python' | 'json'): Promise<void> {
        const tab = this.tab();

        if (!tab?.connectionId || !tab.databaseName || !tab.collectionName) {
            return;
        }

        try {
            const result = await firstValueFrom(
                this.api.exportPipeline(
                    tab.connectionId,
                    tab.databaseName,
                    tab.collectionName,
                    this.stages().filter(stage => stage.isEnabled),
                    language
                )
            );

            this.exportedCode.set(result.code);
        } catch (error) {
            this.previewError.set(this.describe(error));
        }
    }

    /** Clears the generated code panel. */
    clearExport(): void {
        this.exportedCode.set(undefined);
    }

    /** Renders one preview document for display. */
    displayDocument(document: Record<string, unknown>): string {
        return toDisplayJson(document);
    }

    /** Extracts a readable message from an HTTP failure. */
    private describe(error: unknown): string {
        if (typeof error === 'object' && error !== null && 'error' in error) {
            const body = (error as { error?: { message?: string; }; }).error;

            if (body?.message) {
                return body.message;
            }
        }

        return error instanceof Error ? error.message : 'The pipeline operation failed.';
    }
}
