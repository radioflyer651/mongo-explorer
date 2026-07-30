import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, takeUntil } from 'rxjs';
import { ComponentBase } from '../../component-base/component-base.component';
import { WorkspaceService } from '../../../services/workspace.service';
import { AiSessionService } from '../../../services/ai-session.service';
import { ClientApiService } from '../../../services/explorer/api-clients/client-api.service';
import { shellInputRequests } from '../../../core/commands/command-registrations';
import { toDisplayJson } from '../../../core/ejson.util';
import {
    ShellCommandClassification,
    ShellTranscriptEntry,
} from '../../../../model/shared-models/explorer/shell.model';

/**
 * The Mongo shell panel — Tier A, the structured command runner.
 *
 * Commands run through the application's existing connection, which means they reuse
 * its authentication (including OIDC) rather than opening a second credential flow.
 * Input written by an AI lands in the buffer but is never executed: the user presses
 * Enter.
 */
@Component({
    selector: 'app-shell-panel',
    imports: [CommonModule, FormsModule],
    templateUrl: './shell-panel.component.html',
    styleUrl: './shell-panel.component.scss',
})
export class ShellPanelComponent extends ComponentBase {
    constructor(readonly workspace: WorkspaceService, readonly ai: AiSessionService) {
        super();
        this.watchForAiInput();
    }

    private readonly api = inject(ClientApiService);

    /** The current input buffer. */
    readonly input = signal('{ "listCollections": 1 }');

    /** Which database commands run against. */
    readonly databaseName = signal('');

    /** The transcript. */
    readonly entries = signal<ShellTranscriptEntry[]>([]);

    /** Whether a command is in flight. */
    readonly isRunning = signal(false);

    /** The most recent error. */
    readonly lastError = signal<string | undefined>(undefined);

    /** How the current input classifies. */
    readonly classification = signal<ShellCommandClassification | undefined>(undefined);

    /** True when an AI wrote the current buffer and the user has not run it. */
    readonly isAiAuthored = signal(false);

    /** Whether a connection is available. */
    readonly hasConnection = computed(() => !!this.workspace.activeTab()?.connectionId);

    /** A hint describing what will happen when the input is submitted. */
    readonly classificationHint = computed(() => {
        switch (this.classification()) {
            case ShellCommandClassification.ReadOnly:
                return 'Read-only command. Safe to run, and available to an AI.';
            case ShellCommandClassification.Write:
                return 'This command writes. Only you can run it — an AI can only propose it.';
            case ShellCommandClassification.Unclassifiable:
                return 'Not on the read-only allow-list. Unrecognised commands are refused for an AI, and you should be sure before running one.';
            default:
                return 'Enter a command document as Extended JSON, for example { "collStats": "orders" }.';
        }
    });

    /** Loads the transcript from the server. */
    reload(): void {
        this.api.getShellTranscript().subscribe(entries => this.entries.set(entries));
    }

    /** Classifies the current input without running it. */
    async classify(): Promise<void> {
        if (!this.input().trim()) {
            this.classification.set(undefined);
            return;
        }

        try {
            const result = await firstValueFrom(this.api.classifyShellCommand(this.input()));
            this.classification.set(result.classification as ShellCommandClassification);
        } catch {
            this.classification.set(ShellCommandClassification.Unclassifiable);
        }
    }

    /** Records an input change and reclassifies. */
    async setInput(value: string): Promise<void> {
        this.input.set(value);
        this.isAiAuthored.set(false);
        await this.classify();
    }

    /** Runs the current input. */
    async run(): Promise<void> {
        /* Ctrl+Enter can arrive while a command is still running; the button's
           disabled class does not stop the keyboard path. */
        if (this.isRunning()) {
            return;
        }

        const tab = this.workspace.activeTab();
        const connectionId = tab?.connectionId;

        if (!connectionId) {
            this.lastError.set('Open a connection first.');
            return;
        }

        const database = this.databaseName().trim() || tab?.databaseName || 'admin';

        this.isRunning.set(true);
        this.lastError.set(undefined);

        try {
            const entry = await firstValueFrom(
                this.api.executeShellCommand(connectionId, database, this.input())
            );

            this.entries.update(current => [...current, entry]);
            this.isAiAuthored.set(false);

            if (entry.status === 'refused') {
                this.lastError.set(entry.error);
            }
        } catch (error) {
            this.lastError.set(this.describe(error));
        } finally {
            this.isRunning.set(false);
        }
    }

    /** Clears the transcript. */
    async clear(): Promise<void> {
        await firstValueFrom(this.api.clearShellTranscript());
        this.entries.set([]);
    }

    /** Puts a previous entry's input back in the buffer. */
    recall(entry: ShellTranscriptEntry): void {
        this.input.set(entry.input);
        this.isAiAuthored.set(false);
        void this.classify();
    }

    /** Renders a result for display. */
    displayResult(entry: ShellTranscriptEntry): string {
        if (!entry.resultJson) {
            return '';
        }

        try {
            return toDisplayJson(JSON.parse(entry.resultJson));
        } catch {
            return entry.resultJson;
        }
    }

    /** Whether an entry came from an AI. */
    isFromAi(entry: ShellTranscriptEntry): boolean {
        return entry.actor === 'mcp';
    }

    /**
     * Picks up input an AI wrote through the MCP server. It lands in the buffer,
     * visibly attributed, and waits for the user.
     */
    private watchForAiInput(): void {
        shellInputRequests.pipe(takeUntil(this.ngDestroy$)).subscribe(input => {
            this.input.set(input);
            this.isAiAuthored.set(true);
            void this.classify();
        });
    }

    /** Extracts a readable message from an HTTP failure. */
    private describe(error: unknown): string {
        if (typeof error === 'object' && error !== null && 'error' in error) {
            const body = (error as { error?: { message?: string; }; }).error;

            if (body?.message) {
                return body.message;
            }
        }

        return error instanceof Error ? error.message : 'The command failed.';
    }
}
