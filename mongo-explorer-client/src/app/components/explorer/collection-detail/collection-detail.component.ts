import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ViewHostComponent } from '../../views/view-host/view-host.component';
import { ComponentBase } from '../../component-base/component-base.component';
import { WorkspaceService } from '../../../services/workspace.service';
import { ExplorerDataService } from '../../../services/explorer/explorer-data.service';
import { ConnectionStateService } from '../../../services/connection-state.service';
import { ViewRegistry } from '../../../core/views/view-registry.service';
import { CollectionViewContext, DocumentViewInputs } from '../../../core/views/document-view.model';
import { FieldActivation } from '../../../core/cells/cell-renderer.model';
import { ContextMenuService } from '../../../core/commands/context-menu.service';
import { validateExtendedJson } from '../../../core/ejson.util';

/**
 * The collection workspace: query bar, view switcher, results, and pagination.
 *
 * The shell owns every piece of state here. Views present it and emit intent, which is
 * what lets a view switch behave like a lens rather than a reload.
 */
@Component({
    selector: 'app-collection-detail',
    imports: [CommonModule, FormsModule, ViewHostComponent],
    templateUrl: './collection-detail.component.html',
    styleUrl: './collection-detail.component.scss',
})
export class CollectionDetailComponent extends ComponentBase {
    constructor(
        readonly workspace: WorkspaceService,
        readonly data: ExplorerDataService,
        readonly viewRegistry: ViewRegistry
    ) {
        super();
    }

    private readonly connections = inject(ConnectionStateService);
    private readonly contextMenu = inject(ContextMenuService);

    /** The most recent filter validation message. */
    readonly filterError = signal<string | undefined>(undefined);

    /** The focused tab. */
    readonly tab = computed(() => this.workspace.activeTab());

    /** Whether a collection is open. */
    readonly hasCollection = computed(() => {
        const tab = this.tab();
        return tab?.kind === 'collection' && !!tab.connectionId && !!tab.databaseName && !!tab.collectionName;
    });

    /** The view context handed to the registry. */
    readonly viewContext = computed<CollectionViewContext | undefined>(() => {
        const tab = this.tab();

        if (!tab?.connectionId || !tab.databaseName || !tab.collectionName) {
            return undefined;
        }

        return {
            connectionId: tab.connectionId,
            databaseName: tab.databaseName,
            collectionName: tab.collectionName,
            isReadOnly: this.connections.statusFor(tab.connectionId)?.isReadOnly ?? false,
        };
    });

    /** The views that can present this collection. */
    readonly availableViews = computed(() => {
        const context = this.viewContext();
        return context ? this.viewRegistry.viewsFor(context) : [];
    });

    /** The active view's descriptor. */
    readonly activeView = computed(() => {
        const context = this.viewContext();
        return context ? this.viewRegistry.resolveFor(context, this.tab()?.viewState.viewId) : undefined;
    });

    /** What the active view is given. */
    readonly viewInputs = computed<DocumentViewInputs>(() => ({
        documents: this.data.page()?.documents ?? [],
        fields: this.data.page()?.fields ?? [],
        selectedIds: this.tab()?.selectedIds ?? [],
        isReadOnly: this.viewContext()?.isReadOnly ?? true,
    }));

    /** Whether the loaded page was capped or timed out. */
    readonly isPartial = computed(() => this.data.page()?.isPartial ?? false);

    /**
     * The partial-results message. Bounded queries make truncation routine, so hiding
     * it would make the application lie regularly.
     */
    readonly partialMessage = computed(() => {
        const page = this.data.page();

        if (!page?.isPartial) {
            return '';
        }

        const total = this.data.totalCount();
        const totalText =
            total === undefined
                ? 'an unknown total'
                : `${this.data.isCountEstimate() ? 'about ' : ''}${total}`;

        switch (page.partialReason) {
            case 'time-limit':
                return `The query hit its time limit. Showing ${page.returnedCount} of ${totalText} documents.`;
            case 'page-cap':
                return `Showing the first ${page.returnedCount} of ${totalText} documents — the page cap was reached.`;
            default:
                return `Showing ${page.returnedCount} of ${totalText} documents. This result is incomplete.`;
        }
    });

    /** Page position text. */
    readonly pageText = computed(() => {
        const tab = this.tab();
        const page = this.data.page();

        if (!tab || !page) {
            return '';
        }

        const from = tab.viewState.skip + 1;
        const to = tab.viewState.skip + page.returnedCount;
        const total = this.data.totalCount();

        return `${from}–${to}${total === undefined ? '' : ` of ${total}`}`;
    });

    /** Whether a previous page exists. */
    readonly canGoBack = computed(() => (this.tab()?.viewState.skip ?? 0) > 0);

    /** Whether a next page exists. */
    readonly canGoForward = computed(() => this.data.page()?.hasMore ?? false);

    /** Applies a filter change without running it. */
    setFilter(value: string): void {
        const validation = validateExtendedJson(value);
        this.filterError.set(validation.isValid ? undefined : validation.message);
        this.workspace.setViewState({ filter: value });
    }

    /** Applies a sort change. */
    setSort(value: string): void {
        this.workspace.setViewState({ sort: value });
    }

    /** Applies a projection change. */
    setProjection(value: string): void {
        this.workspace.setViewState({ projection: value });
    }

    /** Applies a page-size change and reloads. */
    async setLimit(value: number): Promise<void> {
        this.workspace.setViewState({ limit: value, skip: 0 });
        await this.run();
    }

    /** Runs the current query. */
    async run(): Promise<void> {
        if (this.filterError()) {
            return;
        }

        await this.data.loadActiveTab();
    }

    /** Clears the filter and reruns. */
    async clearFilter(): Promise<void> {
        this.filterError.set(undefined);
        this.workspace.setViewState({ filter: '', skip: 0 });
        await this.run();
    }

    /**
     * Moves to the previous page.
     *
     * The bound guard is repeated here because a disabled attribute only stops a
     * pointer: a keyboard shortcut or an MCP-dispatched command reaches this method
     * directly, and paging past the end produces a page position that reads as
     * nonsense.
     */
    async previousPage(): Promise<void> {
        const tab = this.tab();

        if (!tab || !this.canGoBack()) {
            return;
        }

        this.workspace.setViewState({ skip: Math.max(0, tab.viewState.skip - tab.viewState.limit) });
        await this.run();
    }

    /** Moves to the next page, refusing when there is nothing further to load. */
    async nextPage(): Promise<void> {
        const tab = this.tab();

        if (!tab || !this.canGoForward()) {
            return;
        }

        this.workspace.setViewState({ skip: tab.viewState.skip + tab.viewState.limit });
        await this.run();
    }

    /** Switches the active view, preserving filter, sort, and selection. */
    setView(viewId: string): void {
        this.workspace.setViewState({ viewId });
    }

    /** Records a selection change from the active view. */
    onSelectionChange(ids: readonly unknown[]): void {
        this.workspace.setSelection([...ids]);
    }

    /** Raises a field context menu from the active view. */
    onFieldActivated(activation: FieldActivation): void {
        const viewContext = this.viewContext();

        if (!viewContext) {
            return;
        }

        this.contextMenu.open(
            {
                kind: 'field',
                path: activation.cell.path,
                value: activation.cell.value,
                bsonType: activation.cell.bsonType,
                isReadOnly: viewContext.isReadOnly,
            },
            activation.position
        );
    }
}
