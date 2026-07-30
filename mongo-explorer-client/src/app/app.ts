import { CommonModule } from '@angular/common';
import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { ExplorerSidebarComponent } from './components/explorer/explorer-sidebar/explorer-sidebar.component';
import { CollectionDetailComponent } from './components/explorer/collection-detail/collection-detail.component';
import { ConnectionEditorComponent } from './components/connections/connection-editor/connection-editor.component';
import { AiModeSwitchComponent } from './components/ai/ai-mode-switch/ai-mode-switch.component';
import { ProposalsPanelComponent } from './components/ai/proposals-panel/proposals-panel.component';
import { CommandMenuComponent } from './components/commands/command-menu/command-menu.component';
import { CommandToolbarComponent } from './components/commands/command-toolbar/command-toolbar.component';
import { PipelineBuilderComponent } from './components/pipeline/pipeline-builder/pipeline-builder.component';
import { ShellPanelComponent } from './components/shell/shell-panel/shell-panel.component';
import { ComponentBase } from './components/component-base/component-base.component';
import { WorkspaceService } from './services/workspace.service';
import { AiSessionService } from './services/ai-session.service';
import { ExplorerDataService } from './services/explorer/explorer-data.service';
import { CommandRegistry } from './core/commands/command-registry.service';
import { ContextMenuService } from './core/commands/context-menu.service';
import { registerAppCommands } from './core/commands/command-registrations';
import { registerDocumentViews } from './core/views/view-registrations';
import { registerCellRenderers } from './core/cells/cell-registrations';
import { CommandContext } from './core/commands/app-command.model';

/**
 * The application shell: toolbar, sidebar, tab strip, content, and the Proposals
 * panel.
 *
 * Commands, views, and cell renderers are registered here, once, so every surface
 * below renders from the same declarations.
 */
@Component({
    selector: 'app-root',
    imports: [
        CommonModule,
        ExplorerSidebarComponent,
        CollectionDetailComponent,
        ConnectionEditorComponent,
        AiModeSwitchComponent,
        ProposalsPanelComponent,
        CommandMenuComponent,
        CommandToolbarComponent,
        PipelineBuilderComponent,
        ShellPanelComponent,
    ],
    templateUrl: './app.html',
    styleUrl: './app.scss',
})
export class App extends ComponentBase {
    constructor(readonly workspace: WorkspaceService, readonly ai: AiSessionService) {
        super();

        registerAppCommands();
        registerDocumentViews();
        registerCellRenderers();
    }

    private readonly data = inject(ExplorerDataService);
    private readonly registry = inject(CommandRegistry);
    private readonly contextMenu = inject(ContextMenuService);

    /** Whether the connection editor is open. */
    readonly isEditorOpen = signal(false);

    /** Whether the Proposals panel is expanded. */
    readonly isProposalsOpen = signal(false);

    /** Whether the shell panel is docked open at the bottom. */
    readonly isShellOpen = signal(false);

    /** The most recent command failure, so a refusal is never silent. */
    readonly lastMessage = signal<string | undefined>(undefined);

    /**
     * The open context menu.
     *
     * Read from the shared service rather than held here — every surface raises menus
     * into the same place, because there is only one menu to render.
     */
    readonly menuRequest = this.contextMenu.request;

    /** The application-level command context. */
    readonly appContext: CommandContext = { kind: 'app' };

    /** Commands shown in the application toolbar. */
    readonly toolbarCommands: readonly string[] = ['collection.refresh', 'query.run'];

    /** The open tabs. */
    readonly tabs = computed(() => this.workspace.tabs());

    /** How many proposals await a decision. */
    readonly pendingProposals = computed(() => this.ai.pendingProposalCount());

    /** Opens the connection editor. */
    openEditor(): void {
        this.isEditorOpen.set(true);
    }

    /** Closes the connection editor. */
    closeEditor(): void {
        this.isEditorOpen.set(false);
    }

    /** Toggles the Proposals panel. */
    toggleProposals(): void {
        this.isProposalsOpen.update(open => !open);
    }

    /** Toggles the docked shell panel. */
    toggleShell(): void {
        this.isShellOpen.update(open => !open);
    }

    /** Whether the focused tab is the aggregation builder. */
    readonly isPipelineTab = computed(() => this.workspace.activeTab()?.kind === 'pipeline');

    /**
     * Opens the aggregation builder against the focused collection, so the pipeline
     * inherits the collection the user is already looking at.
     */
    openPipeline(): void {
        const current = this.workspace.activeTab();

        if (!current?.connectionId || !current.databaseName || !current.collectionName) {
            this.lastMessage.set('Open a collection first — a pipeline runs against one.');
            return;
        }

        this.workspace.openTab('pipeline', `Pipeline: ${current.databaseName}.${current.collectionName}`, {
            connectionId: current.connectionId,
            databaseName: current.databaseName,
            collectionName: current.collectionName,
        });
    }

    /** Focuses a tab and reloads its data. */
    async focusTab(tabId: string): Promise<void> {
        this.workspace.focusTab(tabId);
        await this.data.loadActiveTab();
    }

    /** Closes a tab, reporting the reason when it refuses. */
    closeTab(tabId: string, event: MouseEvent): void {
        event.stopPropagation();
        const result = this.workspace.closeTab(tabId);

        if (!result.closed) {
            this.lastMessage.set(result.reason);
        }
    }

    /** Surfaces a message from a child surface. */
    reportMessage(message: string): void {
        this.lastMessage.set(message);
    }

    /** Clears the message bar. */
    dismissMessage(): void {
        this.lastMessage.set(undefined);
    }

    /** Clears the context menu. */
    closeMenu(): void {
        this.contextMenu.close();
    }

    /**
     * Dispatches keyboard shortcuts through the registry, so a shortcut is another
     * projection of the same declarations rather than a separate mapping.
     */
    @HostListener('document:keydown', ['$event'])
    async onKeyDown(event: KeyboardEvent): Promise<void> {
        const binding = this.describeBinding(event);

        if (!binding) {
            return;
        }

        const command = this.registry.commandForKeybinding(binding);

        if (!command) {
            return;
        }

        event.preventDefault();

        try {
            await this.registry.execute(command.id, this.appContext);
        } catch (error) {
            this.lastMessage.set(error instanceof Error ? error.message : 'The command failed.');
        }
    }

    /** Renders a key event as a binding string such as 'ctrl+shift+a'. */
    private describeBinding(event: KeyboardEvent): string | undefined {
        const parts: string[] = [];

        if (event.ctrlKey || event.metaKey) {
            parts.push('ctrl');
        }

        if (event.shiftKey) {
            parts.push('shift');
        }

        if (event.altKey) {
            parts.push('alt');
        }

        const key = event.key.toLowerCase();

        if (['control', 'shift', 'alt', 'meta'].includes(key)) {
            return undefined;
        }

        parts.push(key);
        return parts.length > 1 ? parts.join('+') : undefined;
    }
}
