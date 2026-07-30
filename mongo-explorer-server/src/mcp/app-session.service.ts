import { injectable } from 'inversify';
import { ObjectId } from 'mongodb';
import { Observable, Subject } from 'rxjs';
import { McpModeService } from './mcp-mode.service';
import { ConnectionManager } from '../connections/connection-manager.service';
import {
    AppSessionState,
    DirtyRegion,
    DirtySurface,
} from '../model/shared-models/mcp/app-session-state.model';
import { McpRefusal } from '../model/shared-models/mcp/mcp-mode.model';
import { ProposalSummary } from '../model/shared-models/mcp/proposal.model';
import { PublishSessionStateMessage } from '../model/shared-models/socket-messaging/socket-events.model';
import { newId } from '../utils/misc.util';

/** A request to change interface state, sent to the client for dispatch. */
export interface UiMutationRequest {
    /** Identifier so the client can acknowledge and the server can log it. */
    mutationId: string;

    /** Which registered command to dispatch. */
    commandId: string;

    /** Command arguments. */
    args: Record<string, unknown>;

    /** Plain-language description for the attribution badge. */
    description: string;
}

/** Outcome reported back by the client after attempting a mutation. */
export interface UiMutationResult {
    /** Whether the client applied it. */
    applied: boolean;

    /** Why it was refused, when it was. */
    error?: string;

    /** State captured so the change can be undone. */
    undoPayload?: string;
}

/**
 * Server-side mirror of what the user is currently looking at.
 *
 * Interface state lives in the browser and the MCP server runs in Node, so the
 * client publishes its state over the socket and mutations travel back the other
 * way, applied by the client's own command dispatcher — exactly as if a menu item
 * had been clicked.
 */
@injectable()
export class AppSessionService {
    constructor(modeService: McpModeService, connectionManager: ConnectionManager) {
        this.modeService = modeService;
        this.connectionManager = connectionManager;
    }

    private readonly modeService: McpModeService;
    private readonly connectionManager: ConnectionManager;

    private published: PublishSessionStateMessage | undefined;
    private proposals: ProposalSummary[] = [];
    private revisionCounter = 0;
    private sessionCount = 0;

    private readonly stateChanges = new Subject<AppSessionState>();
    private readonly mutationRequests = new Subject<UiMutationRequest>();
    private readonly pendingMutations = new Map<string, (result: UiMutationResult) => void>();

    /** Emits whenever the mirrored state changes. */
    readonly stateChanged$: Observable<AppSessionState> = this.stateChanges.asObservable();

    /** Emits interface mutations for the socket layer to deliver to the client. */
    readonly mutationRequested$: Observable<UiMutationRequest> = this.mutationRequests.asObservable();

    /** Records that a browser session connected. */
    registerSession(): void {
        this.sessionCount += 1;
        this.bumpRevision();
    }

    /** Records that a browser session disconnected. */
    unregisterSession(): void {
        this.sessionCount = Math.max(0, this.sessionCount - 1);

        if (this.sessionCount === 0) {
            this.published = undefined;
        }

        this.bumpRevision();
    }

    /** Whether any browser session is currently connected. */
    get hasActiveSession(): boolean {
        return this.sessionCount > 0;
    }

    /** Accepts a state publication from the client. */
    publish(message: PublishSessionStateMessage): void {
        this.published = message;
        this.bumpRevision();
    }

    /** Replaces the pending proposal list. */
    setProposals(proposals: ProposalSummary[]): void {
        this.proposals = proposals;
        this.bumpRevision();
    }

    /** The current mirrored state. */
    getState(): AppSessionState {
        const activeConnectionId = this.published?.activeConnectionId;
        const live = activeConnectionId ? this.connectionManager.tryGet(new ObjectId(activeConnectionId)) : undefined;

        return {
            hasActiveSession: this.hasActiveSession,
            mcpMode: this.modeService.currentMode,
            activeConnection: live
                ? {
                    connectionId: live.connectionId,
                    name: live.connectionName,
                    state: live.state,
                    isReadOnly: live.isReadOnly,
                    serverCapabilities: live.serverCapabilities,
                }
                : undefined,
            openTabs: this.published?.openTabs ?? [],
            activeTabId: this.published?.activeTabId,
            currentView: this.published?.currentView,
            pipeline: this.published?.pipeline,
            shell: this.published?.shell,
            pendingProposals: this.proposals,
            dirtyRegions: this.published?.dirtyRegions ?? [],
            revision: this.revisionCounter,
        };
    }

    /** The current revision, for optimistic concurrency. */
    get revision(): number {
        return this.revisionCounter;
    }

    /**
     * Refuses when the caller acted on a view the user has since moved on from.
     * Optimistic concurrency against a human is unusual but correct here: the user is
     * an independent writer of the same state.
     */
    checkRevision(expectedRevision: number | undefined): McpRefusal | undefined {
        if (expectedRevision === undefined || expectedRevision === this.revisionCounter) {
            return undefined;
        }

        return {
            code: 'stale_state',
            message: `The interface has changed since revision ${expectedRevision}; it is now at ${this.revisionCounter}.`,
            hint: 'Call get_app_state to read the current state, then decide whether the action still applies.',
            detail: { expectedRevision, actualRevision: this.revisionCounter },
        };
    }

    /**
     * Refuses when a mutation would discard unsaved user work.
     *
     * Not overridable by a force parameter: a force flag would be used, and then it
     * would be used by default.
     */
    checkDirtyState(affectedSurfaces: readonly DirtySurface[], attemptedChange: string): McpRefusal | undefined {
        const dirty = (this.published?.dirtyRegions ?? []).filter(region =>
            affectedSurfaces.includes(region.surface)
        );

        if (!dirty.length) {
            return undefined;
        }

        return {
            code: 'dirty_state_veto',
            message: `This would discard unsaved work: ${dirty.map(region => region.description).join('; ')}.`,
            hint:
                'Do not retry. Tell the user what is unsaved and ask them to apply or discard it first, ' +
                'or choose a different action that does not touch that surface.',
            detail: { blockedBy: dirty as DirtyRegion[], attemptedChange },
        };
    }

    /** Refuses when no browser session is connected to apply a mutation. */
    requireActiveSession(): McpRefusal | undefined {
        if (this.hasActiveSession) {
            return undefined;
        }

        return {
            code: 'no_active_session',
            message: 'No Mongo Explorer browser session is connected, so the interface cannot be changed.',
            hint: 'Ask the user to open Mongo Explorer in a browser. Read-only database tools still work without one.',
        };
    }

    /**
     * Sends a mutation to the client and waits for its acknowledgement. The client
     * applies it through the same command dispatcher a menu item uses.
     */
    async requestMutation(commandId: string, args: Record<string, unknown>, description: string): Promise<UiMutationResult> {
        const request: UiMutationRequest = { mutationId: newId(), commandId, args, description };

        const settled = new Promise<UiMutationResult>(resolve => {
            this.pendingMutations.set(request.mutationId, resolve);

            setTimeout(() => {
                if (this.pendingMutations.delete(request.mutationId)) {
                    resolve({ applied: false, error: 'The application did not acknowledge the change in time.' });
                }
            }, 10_000);
        });

        this.mutationRequests.next(request);
        return await settled;
    }

    /** Completes a pending mutation with the client's acknowledgement. */
    acknowledgeMutation(mutationId: string, result: UiMutationResult): void {
        const resolve = this.pendingMutations.get(mutationId);

        if (resolve) {
            this.pendingMutations.delete(mutationId);
            resolve(result);
        }
    }

    /** Increments the revision and publishes the new state. */
    private bumpRevision(): void {
        this.revisionCounter += 1;
        this.stateChanges.next(this.getState());
    }
}
