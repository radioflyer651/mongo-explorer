import { inject } from '@angular/core';
import { ObjectId } from 'mongodb';
import { firstValueFrom } from 'rxjs';
import {
    AppCommand,
    CommandGroup,
    CommandContext,
    ENABLED,
    disabled,
} from './app-command.model';
import { CommandRegistry } from './command-registry.service';
import { WorkspaceService } from '../../services/workspace.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { ExplorerDataService } from '../../services/explorer/explorer-data.service';
import { AiSessionService } from '../../services/ai-session.service';
import { ClientApiService } from '../../services/explorer/api-clients/client-api.service';
import { ICONS } from '../icons';
import { toExtendedJson, validateExtendedJson } from '../ejson.util';
import { PipelineStage } from '../../../model/shared-models/explorer/pipeline.model';

/** Counter for minting pipeline stage identifiers without a random source. */
let stageCounter = 0;

/**
 * Registers every command.
 *
 * This is the one place an operation is declared. Context menus, toolbars, keyboard
 * shortcuts, in-cell buttons, and the MCP tool surface all render from these
 * declarations, which is what keeps them from drifting apart.
 */
export function registerAppCommands(): void {
    const registry = inject(CommandRegistry);
    const workspace = inject(WorkspaceService);
    const connections = inject(ConnectionStateService);
    const data = inject(ExplorerDataService);
    const ai = inject(AiSessionService);
    const api = inject(ClientApiService);

    /** Refuses when the context's connection forbids writes. */
    function requireWritable(context: CommandContext) {
        const isReadOnly = 'isReadOnly' in context ? context.isReadOnly : false;
        return isReadOnly ? disabled('This connection is marked read-only.') : ENABLED;
    }

    const commands: AppCommand[] = [
        /* ---------- Connections ---------- */
        {
            id: 'connection.connect',
            label: 'Connect',
            icon: ICONS.connect,
            appliesTo: ['connection'],
            group: CommandGroup.Connection,
            order: 10,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: context =>
                context.kind === 'connection' && connections.isUsable(context.connectionId)
                    ? disabled('Already connected.')
                    : ENABLED,
            execute: async context => {
                if (context.kind !== 'connection') {
                    return;
                }

                await firstValueFrom(connections.connect(context.connectionId));
            },
        },
        {
            id: 'connection.disconnect',
            label: 'Disconnect',
            icon: ICONS.disconnect,
            appliesTo: ['connection'],
            group: CommandGroup.Connection,
            order: 20,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: context =>
                context.kind === 'connection' && connections.isUsable(context.connectionId)
                    ? ENABLED
                    : disabled('This connection is not open.'),
            execute: async context => {
                if (context.kind !== 'connection') {
                    return;
                }

                await firstValueFrom(connections.disconnect(context.connectionId));
            },
        },
        {
            id: 'connection.toggleReadOnly',
            label: 'Toggle read-only',
            icon: ICONS.readOnly,
            appliesTo: ['connection'],
            group: CommandGroup.Connection,
            order: 30,
            mcp: 'never',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async context => {
                if (context.kind !== 'connection') {
                    return;
                }

                await firstValueFrom(connections.setReadOnly(context.connectionId, !context.isReadOnly));
            },
        },
        {
            id: 'connection.delete',
            label: 'Delete connection',
            icon: ICONS.delete,
            appliesTo: ['connection'],
            group: CommandGroup.Destructive,
            order: 10,
            isDestructive: true,
            mcp: 'never',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async context => {
                if (context.kind !== 'connection') {
                    return;
                }

                await firstValueFrom(connections.deleteConnection(context.connectionId));
            },
        },

        /* ---------- Databases ---------- */
        {
            id: 'database.refresh',
            label: 'Refresh collections',
            icon: ICONS.refresh,
            appliesTo: ['database'],
            group: CommandGroup.Open,
            order: 10,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: context => {
                if (context.kind !== 'database') {
                    return;
                }

                databaseRefreshRequests.next(context.databaseName);
            },
        },
        {
            id: 'database.copyName',
            label: 'Copy database name',
            icon: ICONS.copy,
            appliesTo: ['database'],
            group: CommandGroup.Clipboard,
            order: 10,
            mcp: 'never',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async context => {
                if (context.kind !== 'database') {
                    return;
                }

                await navigator.clipboard.writeText(context.databaseName);
            },
        },

        /* ---------- Collections ---------- */
        {
            id: 'collection.open',
            label: 'Open',
            icon: ICONS.open,
            appliesTo: ['collection'],
            group: CommandGroup.Open,
            order: 10,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async context => {
                if (context.kind !== 'collection') {
                    return;
                }

                workspace.openCollection(context.connectionId, context.databaseName, context.collectionName);
                await data.loadActiveTab();
            },
        },
        {
            id: 'collection.refresh',
            label: 'Refresh',
            icon: ICONS.refresh,
            appliesTo: ['collection', 'app'],
            group: CommandGroup.Open,
            order: 20,
            keybinding: 'ctrl+r',
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async () => {
                await data.loadActiveTab();
            },
        },
        {
            id: 'collection.drop',
            label: 'Drop collection',
            icon: ICONS.delete,
            appliesTo: ['collection'],
            group: CommandGroup.Destructive,
            order: 20,
            isDestructive: true,
            mcp: 'propose',
            isVisible: () => true,
            isEnabled: requireWritable,
            execute: async context => {
                if (context.kind !== 'collection') {
                    return;
                }

                await firstValueFrom(
                    api.dropCollection(context.connectionId, context.databaseName, context.collectionName)
                );
            },
        },

        /* ---------- Query ---------- */
        {
            id: 'query.set',
            label: 'Set query',
            icon: ICONS.filter,
            appliesTo: ['app'],
            group: CommandGroup.Query,
            order: 10,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => (workspace.activeTab() ? ENABLED : disabled('No collection is open.')),
            execute: () => {
                const args = ai.takePendingArgs();
                const filter = (args['filter'] as string | undefined) ?? '';

                const validation = validateExtendedJson(filter);

                if (!validation.isValid) {
                    throw new Error(`The filter is not valid Extended JSON: ${validation.message}`);
                }

                workspace.setViewState({
                    filter,
                    projection: (args['projection'] as string | undefined) ?? '',
                    sort: (args['sort'] as string | undefined) ?? '',
                    limit: (args['limit'] as number | undefined) ?? workspace.activeTab()?.viewState.limit ?? 50,
                    skip: (args['skip'] as number | undefined) ?? 0,
                });
            },
        },
        {
            id: 'query.run',
            label: 'Run query',
            icon: ICONS.run,
            appliesTo: ['app', 'collection'],
            group: CommandGroup.Query,
            order: 20,
            keybinding: 'ctrl+enter',
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => (workspace.activeTab() ? ENABLED : disabled('No collection is open.')),
            execute: async () => {
                await data.loadActiveTab();
            },
        },
        {
            id: 'query.filterByValue',
            label: 'Filter by this value',
            icon: ICONS.filter,
            appliesTo: ['field'],
            group: CommandGroup.Query,
            order: 30,
            mcp: 'never',
            isVisible: context => context.kind === 'field' && context.bsonType !== 'absent',
            isEnabled: () => ENABLED,
            execute: async context => {
                if (context.kind !== 'field') {
                    return;
                }

                workspace.setViewState({
                    filter: toExtendedJson({ [context.path]: context.value }),
                    skip: 0,
                });

                await data.loadActiveTab();
            },
        },

        /* ---------- Views ---------- */
        {
            id: 'view.setActive',
            label: 'Change view',
            icon: ICONS.viewTable,
            appliesTo: ['app'],
            group: CommandGroup.Open,
            order: 30,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => (workspace.activeTab() ? ENABLED : disabled('No collection is open.')),
            execute: () => {
                const args = ai.takePendingArgs();
                const viewId = args['viewId'] as string | undefined;

                if (!viewId) {
                    throw new Error('No view was named.');
                }

                workspace.setViewState({ viewId });
            },
        },

        /* ---------- Selection ---------- */
        {
            id: 'selection.set',
            label: 'Select documents',
            icon: ICONS.document,
            appliesTo: ['app'],
            group: CommandGroup.Edit,
            order: 10,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => (workspace.activeTab() ? ENABLED : disabled('No collection is open.')),
            execute: () => {
                const args = ai.takePendingArgs();
                const documentIdsJson = (args['documentIdsJson'] as string | undefined) ?? '[]';
                const validation = validateExtendedJson(documentIdsJson);

                if (!validation.isValid) {
                    throw new Error(`The identifier list is not valid Extended JSON: ${validation.message}`);
                }

                workspace.setSelection(JSON.parse(documentIdsJson) as unknown[]);
            },
        },
        {
            id: 'selection.clear',
            label: 'Clear selection',
            icon: ICONS.close,
            appliesTo: ['app'],
            group: CommandGroup.Edit,
            order: 20,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: () => workspace.setSelection([]),
        },

        /* ---------- Tabs ---------- */
        {
            id: 'tab.focus',
            label: 'Focus tab',
            icon: ICONS.open,
            appliesTo: ['app'],
            group: CommandGroup.Open,
            order: 40,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async () => {
                const args = ai.takePendingArgs();
                const tabId = args['tabId'] as string | undefined;

                if (!tabId || !workspace.focusTab(tabId)) {
                    throw new Error('No such tab.');
                }

                await data.loadActiveTab();
            },
        },
        {
            id: 'tab.close',
            label: 'Close tab',
            icon: ICONS.close,
            appliesTo: ['app'],
            group: CommandGroup.Open,
            order: 50,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: () => {
                const args = ai.takePendingArgs();
                const tabId = (args['tabId'] as string | undefined) ?? workspace.activeTabId();

                if (!tabId) {
                    throw new Error('There is no tab to close.');
                }

                const result = workspace.closeTab(tabId);

                if (!result.closed) {
                    throw new Error(result.reason ?? 'The tab could not be closed.');
                }
            },
        },

        /* ---------- Clipboard ---------- */
        {
            id: 'clipboard.copyValue',
            label: 'Copy value',
            icon: ICONS.copy,
            appliesTo: ['field'],
            group: CommandGroup.Clipboard,
            order: 10,
            mcp: 'never',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async context => {
                if (context.kind !== 'field') {
                    return;
                }

                await navigator.clipboard.writeText(
                    typeof context.value === 'string' ? context.value : toExtendedJson(context.value)
                );
            },
        },
        {
            id: 'clipboard.copyFieldPath',
            label: 'Copy field path',
            icon: ICONS.copy,
            appliesTo: ['field'],
            group: CommandGroup.Clipboard,
            order: 20,
            mcp: 'never',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: async context => {
                if (context.kind !== 'field') {
                    return;
                }

                await navigator.clipboard.writeText(context.path);
            },
        },

        /* ---------- Pipeline ---------- */
        {
            id: 'pipeline.set',
            label: 'Replace pipeline',
            icon: ICONS.pipeline,
            appliesTo: ['app'],
            group: CommandGroup.Query,
            order: 40,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => (workspace.activeTab() ? ENABLED : disabled('No collection is open.')),
            execute: () => {
                const args = ai.takePendingArgs();
                const stages = (args['stages'] as PipelineStage[] | undefined) ?? [];

                workspace.updateActiveTab(tab => ({ ...tab, pipelineStages: stages, isPipelineDirty: true }));
            },
        },
        {
            id: 'pipeline.addStage',
            label: 'Add stage',
            icon: ICONS.create,
            appliesTo: ['app'],
            group: CommandGroup.Create,
            order: 10,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => (workspace.activeTab() ? ENABLED : disabled('No collection is open.')),
            execute: () => {
                const args = ai.takePendingArgs();
                const stage = args['stage'] as PipelineStage | undefined;
                const atIndex = args['atIndex'] as number | undefined;

                if (!stage) {
                    throw new Error('No stage was supplied.');
                }

                workspace.updateActiveTab(tab => {
                    const stages = [...tab.pipelineStages];
                    stages.splice(atIndex ?? stages.length, 0, stage);
                    return { ...tab, pipelineStages: stages, isPipelineDirty: true };
                });
            },
        },
        {
            id: 'pipeline.updateStage',
            label: 'Update stage',
            icon: ICONS.edit,
            appliesTo: ['app', 'pipelineStage'],
            group: CommandGroup.Edit,
            order: 30,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: () => {
                const args = ai.takePendingArgs();
                const stageIndex = args['stageIndex'] as number | undefined;
                const stage = args['stage'] as PipelineStage | undefined;

                if (stageIndex === undefined || !stage) {
                    throw new Error('A stage index and stage are required.');
                }

                workspace.updateActiveTab(tab => {
                    if (stageIndex < 0 || stageIndex >= tab.pipelineStages.length) {
                        throw new Error(`There is no stage at index ${stageIndex}.`);
                    }

                    const stages = [...tab.pipelineStages];
                    stages[stageIndex] = stage;
                    return { ...tab, pipelineStages: stages, isPipelineDirty: true };
                });
            },
        },
        {
            id: 'pipeline.toggleStage',
            label: 'Enable or disable stage',
            icon: ICONS.stageEnabled,
            appliesTo: ['app', 'pipelineStage'],
            group: CommandGroup.Edit,
            order: 40,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: () => {
                const args = ai.takePendingArgs();
                const stageIndex = args['stageIndex'] as number | undefined;
                const isEnabled = args['isEnabled'] as boolean | undefined;

                if (stageIndex === undefined) {
                    throw new Error('A stage index is required.');
                }

                workspace.updateActiveTab(tab => {
                    if (stageIndex < 0 || stageIndex >= tab.pipelineStages.length) {
                        throw new Error(`There is no stage at index ${stageIndex}.`);
                    }

                    const stages = [...tab.pipelineStages];
                    stages[stageIndex] = { ...stages[stageIndex], isEnabled: isEnabled ?? !stages[stageIndex].isEnabled };
                    return { ...tab, pipelineStages: stages, isPipelineDirty: true };
                });
            },
        },
        {
            id: 'pipeline.removeStage',
            label: 'Remove stage',
            icon: ICONS.delete,
            appliesTo: ['app', 'pipelineStage'],
            group: CommandGroup.Destructive,
            order: 5,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: () => {
                const args = ai.takePendingArgs();
                const stageIndex = args['stageIndex'] as number | undefined;

                if (stageIndex === undefined) {
                    throw new Error('A stage index is required.');
                }

                workspace.updateActiveTab(tab => {
                    if (stageIndex < 0 || stageIndex >= tab.pipelineStages.length) {
                        throw new Error(`There is no stage at index ${stageIndex}.`);
                    }

                    return {
                        ...tab,
                        pipelineStages: tab.pipelineStages.filter((_, index) => index !== stageIndex),
                        isPipelineDirty: true,
                    };
                });
            },
        },

        /* ---------- Shell ---------- */
        {
            id: 'shell.setInput',
            label: 'Set shell input',
            icon: ICONS.shell,
            appliesTo: ['app'],
            group: CommandGroup.Edit,
            order: 50,
            mcp: 'ui',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: () => {
                const args = ai.takePendingArgs();
                const input = (args['input'] as string | undefined) ?? '';
                shellInputRequests.next(input);
            },
        },

        /* ---------- AI ---------- */
        {
            id: 'ai.toggleMode',
            label: 'Toggle AI mode',
            icon: ICONS.aiCollaborate,
            appliesTo: ['app'],
            group: CommandGroup.Admin,
            order: 90,
            keybinding: 'ctrl+shift+a',
            mcp: 'never',
            isVisible: () => true,
            isEnabled: () => ENABLED,
            execute: () => ai.toggleMode(),
        },
    ];

    registry.registerAll(commands);
}

/** Mints a stage identifier. */
export function newStageId(): string {
    stageCounter += 1;
    return `stage-${stageCounter}`;
}

/** Channels through which a command reaches a component that owns local state. */
import { Subject } from 'rxjs';

/** Emits shell input written by an AI, for the shell panel to pick up. */
export const shellInputRequests = new Subject<string>();

/** Emits the name of a database whose collection list should be reloaded. */
export const databaseRefreshRequests = new Subject<string>();
