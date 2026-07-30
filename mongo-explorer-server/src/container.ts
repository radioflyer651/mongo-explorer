import { Container } from 'inversify';
import { TOKENS } from './tokens';
import { getAppConfig } from './config';
import { IAppConfig } from './model/app-config.model';
import { MongoHelper } from './mongo-helper';
import { SecretCipher } from './utils/secret-cipher';

import { LogDbService } from './database/log-db.service';
import { AuthDbService } from './database/auth-db.service';
import { SavedConnectionDbService } from './database/saved-connection-db.service';
import { SavedPipelineDbService } from './database/saved-pipeline-db.service';
import { SettingsDbService } from './database/settings-db.service';
import { ViewPreferenceDbService } from './database/view-preference-db.service';
import { QueryHistoryDbService } from './database/query-history-db.service';

import { IConnectionStrategy } from './connections/connection-strategy';
import { ConnectionStringStrategy } from './connections/strategies/connection-string.strategy';
import { ScramStrategy } from './connections/strategies/scram.strategy';
import { AzureOidcStrategy } from './connections/strategies/azure-oidc.strategy';
import { X509Strategy } from './connections/strategies/x509.strategy';
import { ConnectionManager } from './connections/connection-manager.service';
import { IOidcTokenProvider } from './connections/oidc/oidc-token-provider';
import {
    AuthorizationCodeTokenProvider,
    AzureCliTokenProvider,
    ClientCredentialsTokenProvider,
    DeviceCodeTokenProvider,
    ManagedIdentityTokenProvider,
} from './connections/oidc/azure-token-providers';

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
import { McpToolContext } from './mcp/mcp-tool-context';
import { SocketServer } from './server/socket.server';
import { McpMode } from './model/shared-models/mcp/mcp-mode.model';

/**
 * The single composition root. Every binding is written by hand: Inversify only
 * resolves the parameter types it can already see, and the decorators do not make it
 * automatic.
 *
 * Note the split. Application Database services are singletons bound to one
 * MongoHelper. Target Database services (explorer/) are also singletons, but they are
 * STATELESS — they take a LiveConnection as a parameter on every call rather than
 * capturing one. That is what prevents a connection from leaking between operations.
 */
export async function buildContainer(): Promise<Container> {
    const config = await getAppConfig();
    const container = new Container({ defaultScope: 'Singleton' });

    container.bind<IAppConfig>(TOKENS.AppConfig).toConstantValue(config);

    /* ---------- Application Database ---------- */

    container.bind<MongoHelper>(TOKENS.MongoHelper)
        .toDynamicValue(async () => {
            const helper = new MongoHelper(config.mongo.connectionString, config.mongo.databaseName);
            await helper.connect();
            return helper;
        })
        .inSingletonScope();

    container.bind<SecretCipher>(TOKENS.SecretCipher)
        .toConstantValue(new SecretCipher(config.auth.secretEncryptionKey));

    container.bind<LogDbService>(TOKENS.LogDbService)
        .toDynamicValue(async ctx => new LogDbService(await ctx.container.getAsync<MongoHelper>(TOKENS.MongoHelper)))
        .inSingletonScope();

    container.bind<AuthDbService>(TOKENS.AuthDbService)
        .toDynamicValue(async ctx => new AuthDbService(await ctx.container.getAsync<MongoHelper>(TOKENS.MongoHelper)))
        .inSingletonScope();

    container.bind<SavedConnectionDbService>(TOKENS.SavedConnectionDbService)
        .toDynamicValue(async ctx => new SavedConnectionDbService(
            await ctx.container.getAsync<MongoHelper>(TOKENS.MongoHelper),
            ctx.container.get<SecretCipher>(TOKENS.SecretCipher),
            extractHost(config.mongo.connectionString),
            config.mongo.databaseName
        ))
        .inSingletonScope();

    container.bind<SavedPipelineDbService>(TOKENS.SavedPipelineDbService)
        .toDynamicValue(async ctx => new SavedPipelineDbService(await ctx.container.getAsync<MongoHelper>(TOKENS.MongoHelper)))
        .inSingletonScope();

    container.bind<SettingsDbService>(TOKENS.SettingsDbService)
        .toDynamicValue(async ctx => new SettingsDbService(await ctx.container.getAsync<MongoHelper>(TOKENS.MongoHelper)))
        .inSingletonScope();

    container.bind<ViewPreferenceDbService>(TOKENS.ViewPreferenceDbService)
        .toDynamicValue(async ctx => new ViewPreferenceDbService(await ctx.container.getAsync<MongoHelper>(TOKENS.MongoHelper)))
        .inSingletonScope();

    container.bind<QueryHistoryDbService>(TOKENS.QueryHistoryDbService)
        .toDynamicValue(async ctx => new QueryHistoryDbService(await ctx.container.getAsync<MongoHelper>(TOKENS.MongoHelper)))
        .inSingletonScope();

    /* ---------- OIDC token providers (multi-binding) ---------- */

    container.bind<IOidcTokenProvider>(TOKENS.OidcTokenProviders).toConstantValue(new AuthorizationCodeTokenProvider());
    container.bind<IOidcTokenProvider>(TOKENS.OidcTokenProviders).toConstantValue(new DeviceCodeTokenProvider());
    container.bind<IOidcTokenProvider>(TOKENS.OidcTokenProviders).toConstantValue(new ManagedIdentityTokenProvider());
    container.bind<IOidcTokenProvider>(TOKENS.OidcTokenProviders).toConstantValue(new ClientCredentialsTokenProvider());
    container.bind<IOidcTokenProvider>(TOKENS.OidcTokenProviders).toConstantValue(new AzureCliTokenProvider());

    /* ---------- Connection strategies (multi-binding) ---------- */

    container.bind<IConnectionStrategy>(TOKENS.ConnectionStrategies).toConstantValue(new ConnectionStringStrategy());
    container.bind<IConnectionStrategy>(TOKENS.ConnectionStrategies).toConstantValue(new ScramStrategy());
    container.bind<IConnectionStrategy>(TOKENS.ConnectionStrategies).toConstantValue(new X509Strategy());

    /* Binds after the token providers above, so it can aggregate them. */
    container.bind<IConnectionStrategy>(TOKENS.ConnectionStrategies)
        .toDynamicValue(async ctx => new AzureOidcStrategy(
            await ctx.container.getAllAsync<IOidcTokenProvider>(TOKENS.OidcTokenProviders)
        ))
        .inSingletonScope();

    container.bind<ConnectionManager>(TOKENS.ConnectionManager)
        .toDynamicValue(async ctx => new ConnectionManager(
            await ctx.container.getAllAsync<IConnectionStrategy>(TOKENS.ConnectionStrategies),
            await ctx.container.getAsync<SavedConnectionDbService>(TOKENS.SavedConnectionDbService),
            await ctx.container.getAsync<LogDbService>(TOKENS.LogDbService)
        ))
        .inSingletonScope();

    /* ---------- Target Database services ---------- */

    container.bind<DatabaseExplorerService>(TOKENS.DatabaseExplorerService)
        .toConstantValue(new DatabaseExplorerService(config.limits));
    container.bind<QueryService>(TOKENS.QueryService).toConstantValue(new QueryService(config.limits));
    container.bind<DocumentService>(TOKENS.DocumentService).toConstantValue(new DocumentService(config.limits));
    container.bind<IndexAdminService>(TOKENS.IndexAdminService).toConstantValue(new IndexAdminService(config.limits));
    container.bind<PipelineService>(TOKENS.PipelineService).toConstantValue(new PipelineService(config.limits));
    container.bind<ShellService>(TOKENS.ShellService).toConstantValue(new ShellService(config.limits));
    container.bind<ServerStatusService>(TOKENS.ServerStatusService).toConstantValue(new ServerStatusService(config.limits));

    /* ---------- Model Context Protocol ---------- */

    container.bind<McpModeService>(TOKENS.McpModeService)
        .toDynamicValue(async ctx => {
            const service = new McpModeService(
                await ctx.container.getAsync<SettingsDbService>(TOKENS.SettingsDbService),
                parseMode(config.mcp.defaultMode)
            );
            await service.initialize();
            return service;
        })
        .inSingletonScope();

    container.bind<ActivityService>(TOKENS.ActivityService)
        .toConstantValue(new ActivityService(config.mcp.activityLogLimit));

    container.bind<AppSessionService>(TOKENS.AppSessionService)
        .toDynamicValue(async ctx => new AppSessionService(
            await ctx.container.getAsync<McpModeService>(TOKENS.McpModeService),
            await ctx.container.getAsync<ConnectionManager>(TOKENS.ConnectionManager)
        ))
        .inSingletonScope();

    container.bind<ProposalService>(TOKENS.ProposalService)
        .toDynamicValue(async ctx => new ProposalService(
            await ctx.container.getAsync<ConnectionManager>(TOKENS.ConnectionManager),
            ctx.container.get<DocumentService>(TOKENS.DocumentService),
            ctx.container.get<IndexAdminService>(TOKENS.IndexAdminService),
            ctx.container.get<DatabaseExplorerService>(TOKENS.DatabaseExplorerService),
            ctx.container.get<PipelineService>(TOKENS.PipelineService),
            ctx.container.get<ShellService>(TOKENS.ShellService),
            ctx.container.get<QueryService>(TOKENS.QueryService),
            config.limits
        ))
        .inSingletonScope();

    container.bind<McpServerHost>(TOKENS.McpServerHost)
        .toDynamicValue(async ctx => {
            const toolContext: McpToolContext = {
                modeService: await ctx.container.getAsync<McpModeService>(TOKENS.McpModeService),
                sessionService: await ctx.container.getAsync<AppSessionService>(TOKENS.AppSessionService),
                proposalService: await ctx.container.getAsync<ProposalService>(TOKENS.ProposalService),
                activityService: ctx.container.get<ActivityService>(TOKENS.ActivityService),
                connectionManager: await ctx.container.getAsync<ConnectionManager>(TOKENS.ConnectionManager),
                savedConnections: await ctx.container.getAsync<SavedConnectionDbService>(TOKENS.SavedConnectionDbService),
                savedPipelines: await ctx.container.getAsync<SavedPipelineDbService>(TOKENS.SavedPipelineDbService),
                databaseExplorer: ctx.container.get<DatabaseExplorerService>(TOKENS.DatabaseExplorerService),
                queryService: ctx.container.get<QueryService>(TOKENS.QueryService),
                indexService: ctx.container.get<IndexAdminService>(TOKENS.IndexAdminService),
                pipelineService: ctx.container.get<PipelineService>(TOKENS.PipelineService),
                shellService: ctx.container.get<ShellService>(TOKENS.ShellService),
                serverStatusService: ctx.container.get<ServerStatusService>(TOKENS.ServerStatusService),
            };

            const host = new McpServerHost(toolContext);
            await host.initialize();
            return host;
        })
        .inSingletonScope();

    container.bind<SocketServer>(TOKENS.SocketServer)
        .toDynamicValue(async ctx => new SocketServer(
            await ctx.container.getAsync<AppSessionService>(TOKENS.AppSessionService),
            await ctx.container.getAsync<McpModeService>(TOKENS.McpModeService),
            await ctx.container.getAsync<ProposalService>(TOKENS.ProposalService),
            ctx.container.get<ActivityService>(TOKENS.ActivityService),
            await ctx.container.getAsync<ConnectionManager>(TOKENS.ConnectionManager),
            ctx.container.get<ShellService>(TOKENS.ShellService)
        ))
        .inSingletonScope();

    return container;
}

/** Extracts the host portion of a connection string, for display comparisons. */
function extractHost(connectionString: string): string {
    const match = /\/\/(?:[^@]*@)?([^/?:]+)/.exec(connectionString);
    return match ? match[1] : connectionString;
}

/** Parses a configured mode name, defaulting to Collaborate. */
function parseMode(raw: string): McpMode {
    return Object.values(McpMode).includes(raw as McpMode) ? (raw as McpMode) : McpMode.Collaborate;
}
