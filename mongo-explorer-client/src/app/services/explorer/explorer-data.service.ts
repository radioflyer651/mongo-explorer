import { Injectable, inject, signal } from '@angular/core';
import { ObjectId } from 'mongodb';
import { firstValueFrom } from 'rxjs';
import { ClientApiService } from './api-clients/client-api.service';
import { WorkspaceService } from '../workspace.service';
import { parseDocuments } from '../../core/ejson.util';
import { FieldDescriptor } from '../../../model/shared-models/explorer/bson-type.model';
import { QueryResultPage } from '../../../model/shared-models/explorer/explorer.model';

/** The four states every data surface has. Components, not afterthoughts. */
export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

/** A loaded page of documents, plus everything needed to describe it honestly. */
export interface LoadedPage {
    /** The documents, parsed from Extended JSON. */
    documents: Record<string, unknown>[];

    /** Fields observed in the page, for column derivation. */
    fields: FieldDescriptor[];

    /** How many documents came back. */
    returnedCount: number;

    /** Whether more documents exist beyond this page. */
    hasMore: boolean;

    /** Whether the page was capped or timed out. */
    isPartial: boolean;

    /** Why it is partial, when it is. */
    partialReason?: QueryResultPage['partialReason'];

    /** The limit actually applied after server-side clamping. */
    appliedLimit: number;

    /** Wall-clock duration in milliseconds. */
    durationMs: number;
}

/** Fetches Target Database documents for the focused tab. */
@Injectable({ providedIn: 'root' })
export class ExplorerDataService {
    private readonly api = inject(ClientApiService);
    private readonly workspace = inject(WorkspaceService);

    private readonly _state = signal<LoadState>('idle');
    private readonly _page = signal<LoadedPage | undefined>(undefined);
    private readonly _error = signal<string | undefined>(undefined);
    private readonly _totalCount = signal<number | undefined>(undefined);
    private readonly _isCountEstimate = signal(false);

    /** Current load state. */
    readonly state = this._state.asReadonly();

    /** The loaded page, when one is loaded. */
    readonly page = this._page.asReadonly();

    /** The error text, when the last load failed. */
    readonly error = this._error.asReadonly();

    /** Total matching documents, when counted. */
    readonly totalCount = this._totalCount.asReadonly();

    /** Whether the total is an estimate. */
    readonly isCountEstimate = this._isCountEstimate.asReadonly();

    /** Loads the documents for the focused collection tab. */
    async loadActiveTab(): Promise<void> {
        const tab = this.workspace.activeTab();

        if (!tab?.connectionId || !tab.databaseName || !tab.collectionName) {
            this._state.set('idle');
            this._page.set(undefined);
            return;
        }

        this._state.set('loading');
        this._error.set(undefined);

        try {
            const result = await firstValueFrom(
                this.api.findDocuments(tab.connectionId, tab.databaseName, tab.collectionName, {
                    filter: tab.viewState.filter || undefined,
                    projection: tab.viewState.projection || undefined,
                    sort: tab.viewState.sort || undefined,
                    limit: tab.viewState.limit,
                    skip: tab.viewState.skip,
                })
            );

            this._page.set({
                documents: parseDocuments(result.documentsJson),
                fields: result.fields,
                returnedCount: result.returnedCount,
                hasMore: result.hasMore,
                isPartial: result.isPartial,
                partialReason: result.partialReason,
                appliedLimit: result.appliedLimit,
                durationMs: result.durationMs,
            });

            this._state.set('loaded');
            void this.loadCount(tab.connectionId, tab.databaseName, tab.collectionName, tab.viewState.filter);
        } catch (error) {
            /* The driver's message reaches the user largely intact. Opaque errors are
               the problem this application exists to escape. */
            this._error.set(this.describe(error));
            this._state.set('error');
        }
    }

    /** Counts matching documents so the interface can show a real total. */
    private async loadCount(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        filter: string
    ): Promise<void> {
        try {
            const result = await firstValueFrom(
                this.api.countDocuments(connectionId, databaseName, collectionName, filter || undefined)
            );

            this._totalCount.set(result.count);
            this._isCountEstimate.set(result.isEstimate);
        } catch {
            this._totalCount.set(undefined);
        }
    }

    /** Clears the loaded page. */
    reset(): void {
        this._state.set('idle');
        this._page.set(undefined);
        this._error.set(undefined);
        this._totalCount.set(undefined);
    }

    /** Extracts a readable message from an HTTP failure. */
    private describe(error: unknown): string {
        if (typeof error === 'object' && error !== null && 'error' in error) {
            const body = (error as { error?: { message?: string; }; }).error;

            if (body?.message) {
                return body.message;
            }
        }

        if (error instanceof Error) {
            return error.message;
        }

        return 'The query failed.';
    }
}
