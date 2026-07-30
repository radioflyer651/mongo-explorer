import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ObjectId } from 'mongodb';
import { firstValueFrom, takeUntil } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { databaseRefreshRequests } from '../../../core/commands/command-registrations';
import { ComponentBase } from '../../component-base/component-base.component';
import { ConnectionStateService } from '../../../services/connection-state.service';
import { ClientApiService } from '../../../services/explorer/api-clients/client-api.service';
import { WorkspaceService } from '../../../services/workspace.service';
import { ExplorerDataService } from '../../../services/explorer/explorer-data.service';
import { ContextMenuService } from '../../../core/commands/context-menu.service';
import { colorForConnectionState, iconForConnectionState } from '../../../core/icons';
import { SavedConnectionListing } from '../../../../model/shared-models/connections/saved-connection.model';
import { CollectionSummary, DatabaseSummary } from '../../../../model/shared-models/explorer/explorer.model';
import { ConnectionState } from '../../../../model/shared-models/connections/connection-state.model';

/** One expanded database and its collections. */
interface DatabaseNode {
    /** The database summary. */
    database: DatabaseSummary;

    /** Whether the node is expanded. */
    isExpanded: boolean;

    /** Collections, loaded on expansion. */
    collections?: CollectionSummary[];

    /** Whether the collections are loading. */
    isLoading: boolean;

    /** Error text, when loading failed. */
    error?: string;
}

/**
 * The connection and database tree.
 *
 * Right-click is available on every node, and every node also carries a visible
 * overflow button — right-click alone is undiscoverable, and the intent document is
 * explicit that features must be conspicuous.
 */
@Component({
    selector: 'app-explorer-sidebar',
    imports: [CommonModule, FormsModule],
    templateUrl: './explorer-sidebar.component.html',
    styleUrl: './explorer-sidebar.component.scss',
})
export class ExplorerSidebarComponent extends ComponentBase {
    constructor(readonly connections: ConnectionStateService) {
        super();
        this.connectionList = toSignal(this.connections.connectionListing$, { initialValue: [] });

        /* Bridged from the observable, not read from the getter: a computed over a
           plain property has no signal to depend on, so it would resolve once and
           never update again. */
        this.activeConnectionId = toSignal(this.connections.activeConnectionId$, { initialValue: undefined });

        databaseRefreshRequests.pipe(takeUntil(this.ngDestroy$)).subscribe(databaseName => {
            void this.reloadCollections(databaseName);
        });
    }

    private readonly api = inject(ClientApiService);
    private readonly workspace = inject(WorkspaceService);
    private readonly data = inject(ExplorerDataService);
    private readonly contextMenu = inject(ContextMenuService);

    /** Saved connections. */
    readonly connectionList;

    /** The active connection's identifier. */
    readonly activeConnectionId;

    /** Live connection statuses. */
    readonly statuses = toSignal(inject(ConnectionStateService).statuses$, { initialValue: new Map() });

    /** Databases of the active connection. */
    readonly databases = signal<DatabaseNode[]>([]);

    /** Whether databases are loading. */
    readonly isLoadingDatabases = signal(false);

    /** Error text from the last load. */
    readonly loadError = signal<string | undefined>(undefined);

    /** Filter text applied to the tree. */
    readonly filterText = signal('');

    /** Databases matching the filter. */
    readonly visibleDatabases = computed(() => {
        const filter = this.filterText().trim().toLowerCase();

        if (!filter) {
            return this.databases();
        }

        return this.databases().filter(
            node =>
                node.database.name.toLowerCase().includes(filter) ||
                node.collections?.some(collection => collection.name.toLowerCase().includes(filter))
        );
    });

    /** Icon for a connection's current state. */
    iconFor(connection: SavedConnectionListing): string {
        return iconForConnectionState(this.statusOf(connection)?.state ?? 'disconnected');
    }

    /** Colour for a connection's current state. */
    colorFor(connection: SavedConnectionListing): string {
        return colorForConnectionState(this.statusOf(connection)?.state ?? 'disconnected');
    }

    /** Human-readable state text. */
    stateTextFor(connection: SavedConnectionListing): string {
        const status = this.statusOf(connection);

        if (!status) {
            return 'Not connected';
        }

        return status.message ?? status.error ?? status.state;
    }

    /** Whether a connection is open. */
    isConnected(connection: SavedConnectionListing): boolean {
        const state = this.statusOf(connection)?.state;
        return state === ConnectionState.Connected || state === ConnectionState.CredentialExpiring;
    }

    /** Whether a connection is mid-flight. */
    isBusy(connection: SavedConnectionListing): boolean {
        const state = this.statusOf(connection)?.state;
        return (
            state === ConnectionState.Authenticating ||
            state === ConnectionState.Connecting ||
            state === ConnectionState.Reconnecting ||
            state === ConnectionState.Refreshing
        );
    }

    /** Whether a connection needs the human to do something. */
    needsInteraction(connection: SavedConnectionListing): boolean {
        return this.statusOf(connection)?.state === ConnectionState.AwaitingUserInteraction;
    }

    /** The outstanding interaction prompt, when there is one. */
    interactionFor(connection: SavedConnectionListing) {
        return this.statusOf(connection)?.pendingInteraction;
    }

    /** Opens a connection and loads its databases. */
    async connect(connection: SavedConnectionListing): Promise<void> {
        this.loadError.set(undefined);

        try {
            await firstValueFrom(this.connections.connect(connection._id));
            await this.loadDatabases(connection._id);
        } catch (error) {
            this.loadError.set(this.describe(error));
        }
    }

    /** Closes a connection. */
    async disconnect(connection: SavedConnectionListing, event: MouseEvent): Promise<void> {
        event.stopPropagation();
        await firstValueFrom(this.connections.disconnect(connection._id));
        this.databases.set([]);
    }

    /** Selects a connection, connecting first when necessary. */
    async selectConnection(connection: SavedConnectionListing): Promise<void> {
        if (!this.isConnected(connection)) {
            await this.connect(connection);
            return;
        }

        this.connections.setActiveConnection(connection._id);
        await this.loadDatabases(connection._id);
    }

    /** Loads the database list for a connection. */
    async loadDatabases(connectionId: ObjectId): Promise<void> {
        this.isLoadingDatabases.set(true);
        this.loadError.set(undefined);

        try {
            const summaries = await firstValueFrom(this.api.getDatabases(connectionId));

            this.databases.set(
                summaries.map(database => ({ database, isExpanded: false, isLoading: false }))
            );
        } catch (error) {
            this.loadError.set(this.describe(error));
            this.databases.set([]);
        } finally {
            this.isLoadingDatabases.set(false);
        }
    }

    /** Expands or collapses a database, loading its collections on first expand. */
    async toggleDatabase(node: DatabaseNode): Promise<void> {
        const connectionId = this.activeConnectionId();

        if (!connectionId) {
            return;
        }

        const willExpand = !node.isExpanded;
        this.patchNode(node.database.name, { isExpanded: willExpand });

        if (!willExpand || node.collections) {
            return;
        }

        await this.reloadCollections(node.database.name);
    }

    /** Loads or reloads one database's collection list. */
    async reloadCollections(databaseName: string): Promise<void> {
        const connectionId = this.activeConnectionId();

        if (!connectionId) {
            return;
        }

        this.patchNode(databaseName, { isExpanded: true, isLoading: true, error: undefined });

        try {
            const collections = await firstValueFrom(this.api.getCollections(connectionId, databaseName));
            this.patchNode(databaseName, { collections, isLoading: false });
        } catch (error) {
            this.patchNode(databaseName, { isLoading: false, error: this.describe(error) });
        }
    }

    /** Opens a collection in a tab. */
    async openCollection(databaseName: string, collection: CollectionSummary): Promise<void> {
        const connectionId = this.activeConnectionId();

        if (!connectionId) {
            return;
        }

        this.workspace.openCollection(connectionId, databaseName, collection.name);
        await this.data.loadActiveTab();
    }

    /** Raises a context menu for a connection. */
    openConnectionMenu(connection: SavedConnectionListing, event: MouseEvent): void {
        const status = this.statusOf(connection);

        this.contextMenu.openAt(
            {
                kind: 'connection',
                connectionId: connection._id,
                connectionName: connection.name,
                state: status?.state ?? ConnectionState.Disconnected,
                isReadOnly: connection.isReadOnly,
            },
            event
        );
    }

    /** Raises a context menu for a database. */
    openDatabaseMenu(databaseName: string, event: MouseEvent): void {
        const connectionId = this.activeConnectionId();

        if (!connectionId) {
            return;
        }

        this.contextMenu.openAt(
            {
                kind: 'database',
                connectionId,
                databaseName,
                isReadOnly: this.statuses().get(String(connectionId))?.isReadOnly ?? false,
            },
            event
        );
    }

    /** Raises a context menu for a collection. */
    openCollectionMenu(databaseName: string, collection: CollectionSummary, event: MouseEvent): void {
        const connectionId = this.activeConnectionId();

        if (!connectionId) {
            return;
        }

        this.contextMenu.openAt(
            {
                kind: 'collection',
                connectionId,
                databaseName,
                collectionName: collection.name,
                isReadOnly: this.statuses().get(String(connectionId))?.isReadOnly ?? false,
            },
            event
        );
    }

    /** Formats a byte count for display. */
    formatBytes(bytes: number | undefined): string {
        if (bytes === undefined) {
            return '';
        }

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unit = 0;

        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }

        return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
    }

    /** The live status of one connection. */
    private statusOf(connection: SavedConnectionListing) {
        return this.statuses().get(String(connection._id));
    }

    /** Applies a change to one database node. */
    private patchNode(databaseName: string, change: Partial<DatabaseNode>): void {
        this.databases.update(nodes =>
            nodes.map(node => (node.database.name === databaseName ? { ...node, ...change } : node))
        );
    }

    /** Extracts a readable message from an HTTP failure. */
    private describe(error: unknown): string {
        if (typeof error === 'object' && error !== null && 'error' in error) {
            const body = (error as { error?: { message?: string; }; }).error;

            if (body?.message) {
                return body.message;
            }
        }

        return error instanceof Error ? error.message : 'The operation failed.';
    }
}
