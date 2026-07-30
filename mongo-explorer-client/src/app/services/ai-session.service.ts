import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Socket, io } from 'socket.io-client';
import { ObjectId } from 'mongodb';
import { environment } from '../../environments/environment';
import { ClientApiService } from './explorer/api-clients/client-api.service';
import { ConnectionStateService } from './connection-state.service';
import { WorkspaceService } from './workspace.service';
import { CommandRegistry } from '../core/commands/command-registry.service';
import { CommandContext } from '../core/commands/app-command.model';
import {
    ACKNOWLEDGE_UI_MUTATION,
    ACTIVITY_LOGGED,
    APPLY_UI_MUTATION,
    ActivityLoggedMessage,
    ApplyUiMutationMessage,
    CONNECTION_STATE_CHANGED,
    ConnectionStateChangedMessage,
    MCP_MODE_CHANGED,
    McpModeChangedMessage,
    PROPOSALS_CHANGED,
    PUBLISH_SESSION_STATE,
    ProposalsChangedMessage,
    PublishSessionStateMessage,
    SHELL_ENTRY_CHANGED,
    ShellEntryChangedMessage,
} from '../../model/shared-models/socket-messaging/socket-events.model';
import { ActivityEntry, DirtyRegion } from '../../model/shared-models/mcp/app-session-state.model';
import { McpMode } from '../../model/shared-models/mcp/mcp-mode.model';
import { ProposalSummary } from '../../model/shared-models/mcp/proposal.model';
import { ShellTranscriptEntry } from '../../model/shared-models/explorer/shell.model';

/**
 * The client half of the AI integration.
 *
 * Publishes interface state to the server so the MCP server can mirror it, and
 * applies MCP-originated mutations by dispatching registered commands — exactly the
 * path a menu item takes. An AI is not a special code path.
 */
@Injectable({ providedIn: 'root' })
export class AiSessionService {
    constructor() {
        this.connect();
        this.watchStateForPublishing();
    }

    private readonly api = inject(ClientApiService);
    private readonly connections = inject(ConnectionStateService);
    private readonly workspace = inject(WorkspaceService);
    private readonly registry = inject(CommandRegistry);

    private socket?: Socket;

    private readonly _mode = signal<McpMode>(McpMode.Collaborate);
    private readonly _proposals = signal<ProposalSummary[]>([]);
    private readonly _activity = signal<ActivityEntry[]>([]);
    private readonly _shellEntries = signal<ShellTranscriptEntry[]>([]);
    private readonly _isConnected = signal(false);

    /** The current AI permission mode. */
    readonly mode = this._mode.asReadonly();

    /** Proposals awaiting the user's decision. */
    readonly proposals = this._proposals.asReadonly();

    /** The attribution log, newest first. */
    readonly activity = this._activity.asReadonly();

    /** Shell transcript entries pushed from the server. */
    readonly shellEntries = this._shellEntries.asReadonly();

    /** Whether the socket is connected. */
    readonly isConnected = this._isConnected.asReadonly();

    /** How many proposals are pending. */
    readonly pendingProposalCount = computed(
        () => this._proposals().filter(proposal => proposal.status === 'pending').length
    );

    /** Whether the AI may currently change the interface. */
    readonly canAiChangeUi = computed(() => this._mode() === McpMode.Collaborate);

    /** The most recent undoable AI-originated change. */
    readonly lastUndoableAiChange = computed(() =>
        this._activity().find(entry => entry.actor === 'mcp' && entry.isUndoable && !entry.isUndone)
    );

    /** Opens the socket and registers handlers. */
    private connect(): void {
        this.socket = io(environment.socketUrl, { transports: ['websocket', 'polling'] });

        this.socket.on('connect', () => {
            this._isConnected.set(true);
            this.publishState();
        });

        this.socket.on('disconnect', () => this._isConnected.set(false));

        this.socket.on(CONNECTION_STATE_CHANGED, (message: ConnectionStateChangedMessage) => {
            this.connections.applyStatus(message.status);
        });

        this.socket.on(MCP_MODE_CHANGED, (message: McpModeChangedMessage) => {
            this._mode.set(message.mode);
        });

        this.socket.on(PROPOSALS_CHANGED, (message: ProposalsChangedMessage) => {
            this._proposals.set(message.proposals);
        });

        this.socket.on(ACTIVITY_LOGGED, (message: ActivityLoggedMessage) => {
            this._activity.update(entries => [message.entry, ...entries].slice(0, 200));
        });

        this.socket.on(SHELL_ENTRY_CHANGED, (message: ShellEntryChangedMessage) => {
            this._shellEntries.update(entries => {
                const index = entries.findIndex(entry => entry.id === message.entry.id);

                if (index >= 0) {
                    const next = [...entries];
                    next[index] = message.entry;
                    return next;
                }

                return [...entries, message.entry];
            });
        });

        this.socket.on(APPLY_UI_MUTATION, (message: ApplyUiMutationMessage) => {
            void this.applyMutation(message);
        });

        this.api.getAiMode().subscribe(result => this._mode.set(result.mode));
        this.api.getProposals().subscribe(proposals =>
            this._proposals.set(
                proposals.map(proposal => ({
                    id: proposal.id,
                    kind: proposal.kind,
                    summary: proposal.summary,
                    status: proposal.status,
                    databaseName: proposal.databaseName,
                    collectionName: proposal.collectionName,
                    affectedCount: proposal.affectedCount,
                    createdAt: proposal.createdAt,
                }))
            )
        );
        this.api.getActivity().subscribe(entries => this._activity.set(entries));
    }

    /**
     * Applies an MCP-originated mutation by dispatching a registered command.
     *
     * Nothing here implements behaviour: if a mutation needed special handling, the
     * command declaration would be wrong.
     */
    private async applyMutation(message: ApplyUiMutationMessage): Promise<void> {
        try {
            const context = this.contextForCommand(message.commandId, message.args);

            if (!context) {
                this.acknowledge(message.mutationId, false, 'No suitable context is available for that command.');
                return;
            }

            const undoPayload = this.captureUndoPayload(message.commandId);
            await this.registry.execute(message.commandId, context);
            this.acknowledge(message.mutationId, true, undefined, undoPayload);
        } catch (error) {
            this.acknowledge(
                message.mutationId,
                false,
                error instanceof Error ? error.message : 'The command could not be applied.'
            );
        }
    }

    /** Builds the context a dispatched command needs from its arguments. */
    private contextForCommand(commandId: string, args: Record<string, unknown>): CommandContext | undefined {
        const activeTab = this.workspace.activeTab();
        const connectionId = (args['connectionId'] as ObjectId | undefined) ?? activeTab?.connectionId;

        if (commandId === 'collection.open') {
            const databaseName = args['databaseName'] as string | undefined;
            const collectionName = args['collectionName'] as string | undefined;

            if (!connectionId || !databaseName || !collectionName) {
                return undefined;
            }

            return {
                kind: 'collection',
                connectionId,
                databaseName,
                collectionName,
                isReadOnly: this.isActiveConnectionReadOnly(connectionId),
            };
        }

        /* Everything else acts on the workspace, so an app context carries it, with
           the arguments passed through the pending-args channel below. */
        this.pendingArgs = args;
        return { kind: 'app' };
    }

    /** Arguments for the command currently being dispatched. */
    private pendingArgs: Record<string, unknown> = {};

    /** Reads the arguments supplied with the current dispatch. */
    takePendingArgs(): Record<string, unknown> {
        const args = this.pendingArgs;
        this.pendingArgs = {};
        return args;
    }

    /** Captures enough state to reverse an interface change. */
    private captureUndoPayload(commandId: string): string | undefined {
        const tab = this.workspace.activeTab();

        if (!tab) {
            return undefined;
        }

        if (commandId.startsWith('query.') || commandId.startsWith('view.') || commandId.startsWith('selection.')) {
            return JSON.stringify({ viewState: tab.viewState, selectedIds: tab.selectedIds });
        }

        if (commandId.startsWith('pipeline.')) {
            return JSON.stringify({ pipelineStages: tab.pipelineStages });
        }

        return undefined;
    }

    /** Reports the outcome of a mutation back to the server. */
    private acknowledge(mutationId: string, applied: boolean, error?: string, undoPayload?: string): void {
        this.socket?.emit(ACKNOWLEDGE_UI_MUTATION, { mutationId, applied, error, undoPayload });
    }

    /** Whether the named connection forbids writes. */
    private isActiveConnectionReadOnly(connectionId: ObjectId): boolean {
        return this.connections.statusFor(connectionId)?.isReadOnly ?? false;
    }

    /** Republished whenever anything the server mirrors changes. */
    private watchStateForPublishing(): void {
        effect(() => {
            /* Reading these signals registers the effect's dependencies. */
            this.workspace.tabs();
            this.workspace.activeTabId();
            this.workspace.stagedEditCount();

            this.publishState();
        });
    }

    /** Sends the current interface state to the server for the MCP mirror. */
    publishState(): void {
        if (!this.socket?.connected) {
            return;
        }

        const tab = this.workspace.activeTab();

        const message: PublishSessionStateMessage = {
            openTabs: this.workspace.toTabSummaries(),
            activeTabId: this.workspace.activeTabId(),
            activeConnectionId: this.connections.activeConnectionId,
            dirtyRegions: this.collectDirtyRegions(),
            currentView:
                tab?.kind === 'collection' && tab.connectionId && tab.databaseName && tab.collectionName
                    ? {
                        connectionId: tab.connectionId,
                        databaseName: tab.databaseName,
                        collectionName: tab.collectionName,
                        viewId: tab.viewState.viewId,
                        filter: tab.viewState.filter || undefined,
                        projection: tab.viewState.projection || undefined,
                        sort: tab.viewState.sort || undefined,
                        limit: tab.viewState.limit,
                        skip: tab.viewState.skip,
                        selectedDocumentCount: tab.selectedIds.length,
                        isPartial: false,
                        isReadOnlyConnection: tab.connectionId
                            ? this.isActiveConnectionReadOnly(tab.connectionId)
                            : false,
                    }
                    : undefined,
            pipeline:
                tab?.kind === 'pipeline' && tab.connectionId && tab.databaseName && tab.collectionName
                    ? {
                        connectionId: tab.connectionId,
                        databaseName: tab.databaseName,
                        collectionName: tab.collectionName,
                        stages: tab.pipelineStages,
                        mode: 'stages',
                        hasWriteStage: tab.pipelineStages.some(stage =>
                            stage.isEnabled && ['$out', '$merge'].includes(stage.operator)
                        ),
                        writeStages: tab.pipelineStages
                            .filter(stage => stage.isEnabled && ['$out', '$merge'].includes(stage.operator))
                            .map(stage => stage.operator),
                        isDirty: tab.isPipelineDirty,
                    }
                    : undefined,
        };

        this.socket.emit(PUBLISH_SESSION_STATE, message);
    }

    /**
     * Reports surfaces holding unsaved work, which the server uses to veto any AI
     * mutation that would discard it.
     */
    private collectDirtyRegions(): DirtyRegion[] {
        const regions: DirtyRegion[] = [];

        for (const tab of this.workspace.tabs()) {
            if (tab.stagedEdits.length > 0) {
                regions.push({
                    surface: 'documentEdits',
                    description: `${tab.stagedEdits.length} unapplied edit(s) in '${tab.title}'`,
                    itemCount: tab.stagedEdits.length,
                });
            }

            if (tab.isPipelineDirty) {
                regions.push({
                    surface: 'pipelineBuilder',
                    description: `Unsaved pipeline changes in '${tab.title}'`,
                });
            }
        }

        return regions;
    }

    /** Changes the AI permission mode. */
    setMode(mode: McpMode): void {
        this.api.setAiMode(mode).subscribe(result => this._mode.set(result.mode));
    }

    /** Cycles between Collaborate and Observe, for the keyboard shortcut. */
    toggleMode(): void {
        this.setMode(this._mode() === McpMode.Collaborate ? McpMode.Observe : McpMode.Collaborate);
    }

    /** Reloads the proposal list. */
    reloadProposals(): void {
        this.api.getProposals().subscribe(proposals =>
            this._proposals.set(
                proposals.map(proposal => ({
                    id: proposal.id,
                    kind: proposal.kind,
                    summary: proposal.summary,
                    status: proposal.status,
                    databaseName: proposal.databaseName,
                    collectionName: proposal.collectionName,
                    affectedCount: proposal.affectedCount,
                    createdAt: proposal.createdAt,
                }))
            )
        );
    }
}
