import { injectable } from 'inversify';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { AppSessionService } from '../mcp/app-session.service';
import { McpModeService } from '../mcp/mcp-mode.service';
import { ProposalService } from '../mcp/proposal.service';
import { ActivityService } from '../mcp/activity.service';
import { ConnectionManager } from '../connections/connection-manager.service';
import { ShellService } from '../explorer/shell.service';
import { IAppConfig } from '../model/app-config.model';
import {
    ACKNOWLEDGE_UI_MUTATION,
    ACTIVITY_LOGGED,
    APPLY_UI_MUTATION,
    AcknowledgeUiMutationMessage,
    CONNECTION_STATE_CHANGED,
    MCP_MODE_CHANGED,
    PROPOSALS_CHANGED,
    PUBLISH_SESSION_STATE,
    PublishSessionStateMessage,
    SHELL_ENTRY_CHANGED,
} from '../model/shared-models/socket-messaging/socket-events.model';

/**
 * Real-time channel. Used sparingly: connection state, MCP-originated interface
 * changes, proposal and activity notifications, and shell entry completion.
 * Everything else is request and response.
 */
@injectable()
export class SocketServer {
    constructor(
        sessionService: AppSessionService,
        modeService: McpModeService,
        proposalService: ProposalService,
        activityService: ActivityService,
        connectionManager: ConnectionManager,
        shellService: ShellService
    ) {
        this.sessionService = sessionService;
        this.modeService = modeService;
        this.proposalService = proposalService;
        this.activityService = activityService;
        this.connectionManager = connectionManager;
        this.shellService = shellService;
    }

    private readonly sessionService: AppSessionService;
    private readonly modeService: McpModeService;
    private readonly proposalService: ProposalService;
    private readonly activityService: ActivityService;
    private readonly connectionManager: ConnectionManager;
    private readonly shellService: ShellService;
    private io?: Server;

    /** Attaches to the HTTP server and wires every outbound stream. */
    registerWithServer(config: IAppConfig, server: http.Server): void {
        this.io = new Server(server, {
            cors: { origin: config.corsAllowed, methods: ['GET', 'POST'] },
        });

        this.io.on('connection', socket => this.handleConnection(socket));

        this.connectionManager.status$.subscribe(status => {
            this.io?.emit(CONNECTION_STATE_CHANGED, { status });
        });

        this.sessionService.mutationRequested$.subscribe(request => {
            this.io?.emit(APPLY_UI_MUTATION, request);
        });

        this.modeService.modeChanged$.subscribe(change => {
            this.io?.emit(MCP_MODE_CHANGED, change);
        });

        this.proposalService.changed$.subscribe(proposals => {
            this.sessionService.setProposals(proposals);
            this.io?.emit(PROPOSALS_CHANGED, { proposals });
        });

        this.activityService.appended$.subscribe(entry => {
            this.io?.emit(ACTIVITY_LOGGED, { entry });
        });

        this.shellService.entryChanged$.subscribe(entry => {
            this.io?.emit(SHELL_ENTRY_CHANGED, { entry });
        });
    }

    /** Closes the socket server. */
    async close(): Promise<void> {
        await new Promise<void>(resolve => {
            if (!this.io) {
                resolve();
                return;
            }

            this.io.close(() => resolve());
        });

        this.io = undefined;
    }

    /** Registers a browser session and its inbound handlers. */
    private handleConnection(socket: Socket): void {
        this.sessionService.registerSession();

        socket.on(PUBLISH_SESSION_STATE, (message: PublishSessionStateMessage) => {
            this.sessionService.publish(message);
        });

        socket.on(ACKNOWLEDGE_UI_MUTATION, (message: AcknowledgeUiMutationMessage) => {
            this.sessionService.acknowledgeMutation(message.mutationId, {
                applied: message.applied,
                error: message.error,
                undoPayload: message.undoPayload,
            });
        });

        socket.on('disconnect', () => {
            this.sessionService.unregisterSession();
        });
    }
}
