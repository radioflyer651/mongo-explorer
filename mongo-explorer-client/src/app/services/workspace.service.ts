import { Injectable, computed, signal } from '@angular/core';
import { ObjectId } from 'mongodb';
import {
    CollectionViewState,
    createDefaultViewState,
} from '../core/views/document-view.model';
import { TabSummary } from '../../model/shared-models/mcp/app-session-state.model';
import { PipelineStage } from '../../model/shared-models/explorer/pipeline.model';

/** One open workspace tab and everything scoped to it. */
export interface WorkspaceTab {
    /** Stable identifier. */
    readonly id: string;

    /** What the tab shows. */
    readonly kind: TabSummary['kind'];

    /** Display title. */
    title: string;

    /** Connection the tab is bound to. */
    connectionId?: ObjectId;

    /** Target Database name. */
    databaseName?: string;

    /** Collection name. */
    collectionName?: string;

    /**
     * Shell-owned view state. Lives here rather than inside a view so switching
     * views keeps the same page and selection — a lens, not a reload.
     */
    viewState: CollectionViewState;

    /** Selected document identifiers. Any BSON type. */
    selectedIds: unknown[];

    /** Aggregation builder stages, for a pipeline tab. */
    pipelineStages: PipelineStage[];

    /** Whether the pipeline has unsaved edits. */
    isPipelineDirty: boolean;

    /** Staged document edits awaiting an explicit apply. */
    stagedEdits: StagedEdit[];
}

/** One document edit staged but not yet applied. */
export interface StagedEdit {
    /** Stable identifier. */
    id: string;

    /** Identifier of the document being edited. Any BSON type. */
    documentId: unknown;

    /** Filter that selects the document, as Extended JSON. */
    filterJson: string;

    /** The update or replacement, as Extended JSON. */
    payloadJson: string;

    /** Whether this is an update or a wholesale replacement. */
    kind: 'update' | 'replace' | 'insert' | 'delete';

    /** Plain-language description shown in the pending-changes list. */
    description: string;
}

/** Counter used to mint tab identifiers without a random source. */
let tabCounter = 0;

/**
 * Owns the open tabs and every piece of state scoped to one.
 *
 * Edits are staged here and applied explicitly. A grid that writes to a production
 * database on focus-loss is a hazard, not a convenience — and staging is also what
 * lets an AI's proposals land in the same buffer a human's edits land in.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
    private readonly _tabs = signal<WorkspaceTab[]>([]);
    private readonly _activeTabId = signal<string | undefined>(undefined);

    /** Every open tab. */
    readonly tabs = this._tabs.asReadonly();

    /** Which tab is focused. */
    readonly activeTabId = this._activeTabId.asReadonly();

    /** The focused tab, when there is one. */
    readonly activeTab = computed(() => this._tabs().find(tab => tab.id === this._activeTabId()));

    /** Total staged edits across every tab. */
    readonly stagedEditCount = computed(() =>
        this._tabs().reduce((total, tab) => total + tab.stagedEdits.length, 0)
    );

    /** Whether any tab holds unsaved work. */
    readonly hasUnsavedWork = computed(() =>
        this._tabs().some(tab => tab.stagedEdits.length > 0 || tab.isPipelineDirty)
    );

    /** Opens a collection tab, focusing an existing one when it matches. */
    openCollection(connectionId: ObjectId, databaseName: string, collectionName: string): WorkspaceTab {
        const existing = this._tabs().find(
            tab =>
                tab.kind === 'collection' &&
                tab.connectionId === connectionId &&
                tab.databaseName === databaseName &&
                tab.collectionName === collectionName
        );

        if (existing) {
            this._activeTabId.set(existing.id);
            return existing;
        }

        const tab = this.createTab('collection', `${databaseName}.${collectionName}`, {
            connectionId,
            databaseName,
            collectionName,
        });

        this._tabs.update(tabs => [...tabs, tab]);
        this._activeTabId.set(tab.id);
        return tab;
    }

    /** Opens a tab of a non-collection kind. */
    openTab(kind: TabSummary['kind'], title: string, scope: Partial<WorkspaceTab> = {}): WorkspaceTab {
        const existing = this._tabs().find(tab => tab.kind === kind && kind !== 'collection');

        if (existing) {
            this._activeTabId.set(existing.id);
            return existing;
        }

        const tab = this.createTab(kind, title, scope);
        this._tabs.update(tabs => [...tabs, tab]);
        this._activeTabId.set(tab.id);
        return tab;
    }

    /** Focuses a tab. */
    focusTab(tabId: string): boolean {
        if (!this._tabs().some(tab => tab.id === tabId)) {
            return false;
        }

        this._activeTabId.set(tabId);
        return true;
    }

    /** Closes a tab. Refuses when it holds unsaved work. */
    closeTab(tabId: string): { closed: boolean; reason?: string; } {
        const tab = this._tabs().find(candidate => candidate.id === tabId);

        if (!tab) {
            return { closed: false, reason: 'No such tab.' };
        }

        if (tab.stagedEdits.length > 0) {
            return {
                closed: false,
                reason: `'${tab.title}' has ${tab.stagedEdits.length} unapplied edit(s). Apply or discard them first.`,
            };
        }

        if (tab.isPipelineDirty) {
            return { closed: false, reason: `'${tab.title}' has unsaved pipeline changes.` };
        }

        const remaining = this._tabs().filter(candidate => candidate.id !== tabId);
        this._tabs.set(remaining);

        if (this._activeTabId() === tabId) {
            this._activeTabId.set(remaining[remaining.length - 1]?.id);
        }

        return { closed: true };
    }

    /** Applies a change to one tab, immutably. */
    updateTab(tabId: string, change: (tab: WorkspaceTab) => WorkspaceTab): void {
        this._tabs.update(tabs => tabs.map(tab => (tab.id === tabId ? change({ ...tab }) : tab)));
    }

    /** Applies a change to the focused tab. */
    updateActiveTab(change: (tab: WorkspaceTab) => WorkspaceTab): void {
        const activeId = this._activeTabId();

        if (activeId) {
            this.updateTab(activeId, change);
        }
    }

    /** Replaces the view state of the focused tab. */
    setViewState(change: Partial<CollectionViewState>): void {
        this.updateActiveTab(tab => ({ ...tab, viewState: { ...tab.viewState, ...change } }));
    }

    /** Replaces the selection of the focused tab. */
    setSelection(documentIds: unknown[]): void {
        this.updateActiveTab(tab => ({ ...tab, selectedIds: [...documentIds] }));
    }

    /** Stages an edit on the focused tab. */
    stageEdit(edit: StagedEdit): void {
        this.updateActiveTab(tab => ({ ...tab, stagedEdits: [...tab.stagedEdits, edit] }));
    }

    /** Removes one staged edit. */
    discardEdit(editId: string): void {
        this.updateActiveTab(tab => ({
            ...tab,
            stagedEdits: tab.stagedEdits.filter(edit => edit.id !== editId),
        }));
    }

    /** Clears every staged edit on the focused tab. */
    discardAllEdits(): void {
        this.updateActiveTab(tab => ({ ...tab, stagedEdits: [] }));
    }

    /** Reduces the open tabs to the summary shape the server mirrors. */
    toTabSummaries(): TabSummary[] {
        return this._tabs().map(tab => ({
            id: tab.id,
            kind: tab.kind,
            title: tab.title,
            connectionId: tab.connectionId,
            databaseName: tab.databaseName,
            collectionName: tab.collectionName,
        }));
    }

    /** Builds a tab with default state. */
    private createTab(kind: TabSummary['kind'], title: string, scope: Partial<WorkspaceTab>): WorkspaceTab {
        tabCounter += 1;

        return {
            id: `tab-${tabCounter}`,
            kind,
            title,
            connectionId: scope.connectionId,
            databaseName: scope.databaseName,
            collectionName: scope.collectionName,
            viewState: createDefaultViewState(),
            selectedIds: [],
            pipelineStages: scope.pipelineStages ?? [],
            isPipelineDirty: false,
            stagedEdits: [],
        };
    }
}
