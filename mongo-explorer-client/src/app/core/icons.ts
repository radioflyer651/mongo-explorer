/**
 * The canonical icon map.
 *
 * Icons are declared only here and referenced from command and view descriptors. No
 * component hard-codes an icon class — that is how one operation ends up with three
 * different glyphs.
 */
export const ICONS = {
    /* Objects */
    connection: 'pi pi-server',
    database: 'pi pi-database',
    collection: 'pi pi-table',
    document: 'pi pi-file',
    field: 'pi pi-tag',
    index: 'pi pi-sort-alt',
    users: 'pi pi-users',
    roles: 'pi pi-shield',

    /* Operations */
    open: 'pi pi-arrow-right',
    connect: 'pi pi-sign-in',
    disconnect: 'pi pi-sign-out',
    refresh: 'pi pi-refresh',
    create: 'pi pi-plus',
    edit: 'pi pi-pencil',
    duplicate: 'pi pi-clone',
    copy: 'pi pi-copy',
    delete: 'pi pi-trash',
    filter: 'pi pi-filter',
    search: 'pi pi-search',
    run: 'pi pi-play',
    explain: 'pi pi-bolt',
    exportData: 'pi pi-download',
    importData: 'pi pi-upload',
    history: 'pi pi-history',
    savedQuery: 'pi pi-bookmark',
    settings: 'pi pi-cog',
    overflow: 'pi pi-ellipsis-v',
    expand: 'pi pi-chevron-right',
    collapse: 'pi pi-chevron-down',
    close: 'pi pi-times',
    confirm: 'pi pi-check',

    /* Views */
    viewTable: 'pi pi-table',
    viewJson: 'pi pi-code',
    viewList: 'pi pi-list',
    viewTree: 'pi pi-sitemap',
    viewSchema: 'pi pi-chart-bar',

    /* Status */
    connected: 'pi pi-check-circle',
    connecting: 'pi pi-spin pi-spinner',
    awaitingUser: 'pi pi-external-link',
    credentialExpiring: 'pi pi-clock',
    authFailed: 'pi pi-lock',
    readOnly: 'pi pi-ban',
    warning: 'pi pi-exclamation-triangle',
    danger: 'pi pi-trash',

    /* Pipeline, shell, and AI */
    pipeline: 'pi pi-sitemap',
    stage: 'pi pi-circle-fill',
    stageEnabled: 'pi pi-eye',
    stageDisabled: 'pi pi-eye-slash',
    preview: 'pi pi-search-plus',
    shell: 'pi pi-terminal',
    aiCollaborate: 'pi pi-sparkles',
    aiObserve: 'pi pi-eye',
    aiOff: 'pi pi-ban',
    proposals: 'pi pi-inbox',
    activity: 'pi pi-history',
} as const;

/** Icon for a connection state. */
export function iconForConnectionState(state: string): string {
    switch (state) {
        case 'connected':
            return ICONS.connected;
        case 'authenticating':
        case 'connecting':
        case 'reconnecting':
        case 'refreshing':
            return ICONS.connecting;
        case 'awaiting-user-interaction':
            return ICONS.awaitingUser;
        case 'credential-expiring':
            return ICONS.credentialExpiring;
        case 'auth-failed':
            return ICONS.authFailed;
        default:
            return ICONS.connection;
    }
}

/**
 * Colour token for a connection state.
 *
 * Every status carries a distinct shape as well as a colour: connection state is the
 * most important signal in the application and it must survive a colourblind user and
 * a bad monitor.
 */
export function colorForConnectionState(state: string): string {
    switch (state) {
        case 'connected':
            return 'var(--color-success)';
        case 'credential-expiring':
            return 'var(--color-warning)';
        case 'auth-failed':
            return 'var(--color-danger)';
        case 'awaiting-user-interaction':
            return 'var(--color-info)';
        default:
            return 'var(--color-text-muted)';
    }
}
