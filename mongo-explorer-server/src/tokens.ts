/** Inversify injection tokens. One symbol per injectable. */
export const TOKENS = {
    AppConfig: Symbol('AppConfig'),

    /* Application Database. */
    MongoHelper: Symbol('MongoHelper'),
    LogDbService: Symbol('LogDbService'),
    AuthDbService: Symbol('AuthDbService'),
    SavedConnectionDbService: Symbol('SavedConnectionDbService'),
    SavedPipelineDbService: Symbol('SavedPipelineDbService'),
    SettingsDbService: Symbol('SettingsDbService'),
    ViewPreferenceDbService: Symbol('ViewPreferenceDbService'),
    QueryHistoryDbService: Symbol('QueryHistoryDbService'),

    /* Secrets. */
    SecretCipher: Symbol('SecretCipher'),

    /* Target Database access. */
    ConnectionStrategies: Symbol('ConnectionStrategies'),
    ConnectionManager: Symbol('ConnectionManager'),
    OidcTokenProviders: Symbol('OidcTokenProviders'),

    /* Explorer services — factories, never connection-bound singletons. */
    DatabaseExplorerService: Symbol('DatabaseExplorerService'),
    CollectionExplorerService: Symbol('CollectionExplorerService'),
    DocumentService: Symbol('DocumentService'),
    QueryService: Symbol('QueryService'),
    PipelineService: Symbol('PipelineService'),
    ShellService: Symbol('ShellService'),
    IndexAdminService: Symbol('IndexAdminService'),
    ServerStatusService: Symbol('ServerStatusService'),
    SchemaService: Symbol('SchemaService'),

    /* Real-time. */
    SocketServer: Symbol('SocketServer'),

    /* Model Context Protocol. */
    McpModeService: Symbol('McpModeService'),
    AppSessionService: Symbol('AppSessionService'),
    ProposalService: Symbol('ProposalService'),
    ActivityService: Symbol('ActivityService'),
    McpServerHost: Symbol('McpServerHost'),
};
