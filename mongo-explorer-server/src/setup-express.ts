import express, { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { Container } from 'inversify';
import { TOKENS } from './tokens';
import { IAppConfig } from './model/app-config.model';
import { LogDbService } from './database/log-db.service';
import { AuthDbService } from './database/auth-db.service';
import { SavedConnectionDbService } from './database/saved-connection-db.service';
import { SavedPipelineDbService } from './database/saved-pipeline-db.service';
import { QueryHistoryDbService } from './database/query-history-db.service';
import { ConnectionManager } from './connections/connection-manager.service';
import { DatabaseExplorerService } from './explorer/database-explorer.service';
import { QueryService } from './explorer/query.service';
import { DocumentService } from './explorer/document.service';
import { IndexAdminService } from './explorer/index-admin.service';
import { PipelineService } from './explorer/pipeline.service';
import { ShellService } from './explorer/shell.service';
import { ServerStatusService } from './explorer/server-status.service';
import { McpModeService } from './mcp/mcp-mode.service';
import { AppSessionService } from './mcp/app-session.service';
import { ProposalService } from './mcp/proposal.service';
import { ActivityService } from './mcp/activity.service';
import { McpServerHost } from './mcp/mcp-server';
import { authMiddleware, configureAnonymousUser, configureLoginRequirement } from './auth/auth-middleware';
import { configureJwt } from './auth/jwt';
import { createAuthRouter } from './server/auth.server';
import { createConnectionsRouter } from './server/connections.server';
import { createExplorerRouter } from './server/explorer.server';
import { createPipelineRouter } from './server/pipeline.server';
import { createShellRouter } from './server/shell.server';
import { createAiRouter } from './server/ai.server';
import { errorMessage } from './utils/misc.util';
import { redactObject } from './utils/redaction.util';

/** Builds and wires the Express application. */
export async function initializeExpressApp(container: Container): Promise<Application> {
    const config = container.get<IAppConfig>(TOKENS.AppConfig);
    const app = express();

    /* Exactly the local client origin. Never a wildcard: this server is bound to
       loopback and serves one user. */
    app.use(cors({ origin: config.corsAllowed, credentials: true }));
    app.use(express.json({ limit: '16mb' }));

    const logService = await container.getAsync<LogDbService>(TOKENS.LogDbService);
    const authDbService = await container.getAsync<AuthDbService>(TOKENS.AuthDbService);
    const savedConnections = await container.getAsync<SavedConnectionDbService>(TOKENS.SavedConnectionDbService);
    const savedPipelines = await container.getAsync<SavedPipelineDbService>(TOKENS.SavedPipelineDbService);
    const queryHistory = await container.getAsync<QueryHistoryDbService>(TOKENS.QueryHistoryDbService);
    const connectionManager = await container.getAsync<ConnectionManager>(TOKENS.ConnectionManager);
    const modeService = await container.getAsync<McpModeService>(TOKENS.McpModeService);
    const sessionService = await container.getAsync<AppSessionService>(TOKENS.AppSessionService);
    const proposalService = await container.getAsync<ProposalService>(TOKENS.ProposalService);
    const activityService = container.get<ActivityService>(TOKENS.ActivityService);

    const databaseExplorer = container.get<DatabaseExplorerService>(TOKENS.DatabaseExplorerService);
    const queryService = container.get<QueryService>(TOKENS.QueryService);
    const documentService = container.get<DocumentService>(TOKENS.DocumentService);
    const indexService = container.get<IndexAdminService>(TOKENS.IndexAdminService);
    const pipelineService = container.get<PipelineService>(TOKENS.PipelineService);
    const shellService = container.get<ShellService>(TOKENS.ShellService);
    const serverStatusService = container.get<ServerStatusService>(TOKENS.ServerStatusService);

    configureJwt(config.auth.jwtSecret, config.auth.tokenExpiry);
    configureLoginRequirement(config.auth.requireLogin);

    const defaultUserName = process.env['USERNAME'] || process.env['USER'] || 'local';
    const user = await authDbService.getOrCreateUser(defaultUserName);
    configureAnonymousUser(user._id, user.userName);

    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok', mcpEnabled: config.mcp.enabled });
    });

    /* The MCP endpoint authenticates by reachability: it is bound to loopback, and
       anything that can reach loopback can already read app-config.json. Recorded as
       a deliberate decision in workspace/open-questions.md. */
    if (config.mcp.enabled) {
        const mcpHost = await container.getAsync<McpServerHost>(TOKENS.McpServerHost);

        app.all(config.mcp.path, async (req, res) => {
            await mcpHost.handleRequest(req, res);
        });

        app.get('/api/mcp/tools', (_req, res) => {
            res.json({ tools: mcpHost.getRegisteredToolNames() });
        });
    }

    /* Public: login must be reachable without a token. */
    app.use(createAuthRouter(authDbService, config.auth.requireLogin, defaultUserName));

    app.use(authMiddleware);

    app.use(createConnectionsRouter(savedConnections, connectionManager, modeService));
    app.use(createExplorerRouter(
        connectionManager,
        databaseExplorer,
        queryService,
        documentService,
        indexService,
        serverStatusService,
        proposalService,
        queryHistory
    ));
    app.use(createPipelineRouter(connectionManager, pipelineService, savedPipelines));
    app.use(createShellRouter(connectionManager, shellService));
    app.use(createAiRouter(modeService, sessionService, proposalService, activityService));

    app.use((req, res) => {
        res.status(404).json({ message: `No route matches ${req.method} ${req.path}.` });
    });

    /* Four arguments, so Express recognises this as the error handler. */
    app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
        const message = errorMessage(err);
        console.error(`Unhandled error on ${req.method} ${req.path}:`, redactObject(err));

        logService
            .logMessage({
                level: 'error',
                message: `Unhandled error: ${message}`,
                data: { path: req.path, method: req.method },
            })
            .catch(() => {
                /* Logging must never mask the original failure. */
            });

        if (!res.headersSent) {
            res.status(500).json({ message: 'Internal server error' });
        }
    });

    return app;
}
