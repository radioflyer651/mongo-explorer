/**
 * Application Database collection names, centralised so collection strings are
 * never typed inline.
 *
 * Target Database collection names are runtime user data and deliberately have no
 * constants here.
 */
export const DbCollectionNames = {
    /** The single application user. */
    Users: 'users',

    /** Saved Target Database connections, with secrets encrypted at rest. */
    SavedConnections: 'savedConnections',

    /** Saved aggregation pipelines. */
    SavedPipelines: 'savedPipelines',

    /** Saved queries and favourites. */
    SavedQueries: 'savedQueries',

    /** Per-collection interface preferences: view choice, column layout. */
    ViewPreferences: 'viewPreferences',

    /** Application settings, including the persisted MCP mode. */
    Settings: 'settings',

    /** Application log entries. */
    Logs: 'logs',

    /** Query history. */
    QueryHistory: 'queryHistory',
} as const;

/** Union of every Application Database collection name. */
export type DbCollectionName = typeof DbCollectionNames[keyof typeof DbCollectionNames];
