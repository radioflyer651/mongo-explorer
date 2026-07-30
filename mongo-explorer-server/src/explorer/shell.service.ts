import { injectable } from 'inversify';
import { Document } from 'mongodb';
import { Observable, Subject } from 'rxjs';
import { ExplorerServiceBase } from './explorer-base';
import { LiveConnection, ReadOnlyConnectionError } from '../connections/live-connection';
import { OperationActor, assertUserActor } from './operation-actor';
import { ILimitsConfig } from '../model/app-config.model';
import {
    READ_ONLY_SHELL_COMMANDS,
    ShellCommandClassification,
    ShellExecuteRequest,
    ShellTier,
    ShellTranscriptEntry,
    WRITE_SHELL_COMMANDS,
} from '../model/shared-models/explorer/shell.model';
import { parseExtendedJsonObject, toExtendedJson } from '../utils/ejson.util';
import { errorMessage, newId, nowIso } from '../utils/misc.util';
import { redactText } from '../utils/redaction.util';

/** Raised when a submitted shell command cannot be classified as safe. */
export class UnclassifiableCommandError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnclassifiableCommandError';
    }
}

/**
 * Tier A shell: structured db.runCommand() over the existing LiveConnection.
 *
 * This tier reuses the application's authentication — including OIDC — so the shell
 * works against Azure vCore on day one with no second credential flow. Its commands
 * are classifiable by name, which is what makes it safe to expose to an AI for
 * read-only use.
 *
 * Tier B (real mongosh) is deliberately not implemented here: it cannot share this
 * connection, and classifying arbitrary JavaScript as read-only is undecidable.
 */
@injectable()
export class ShellService extends ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        super(limits);
    }

    private readonly transcript: ShellTranscriptEntry[] = [];
    private readonly entryChanges = new Subject<ShellTranscriptEntry>();

    /** Emits whenever a transcript entry is created or completed. */
    readonly entryChanged$: Observable<ShellTranscriptEntry> = this.entryChanges.asObservable();

    /** The current transcript, oldest first. */
    getTranscript(): ShellTranscriptEntry[] {
        return [...this.transcript];
    }

    /** Returns one transcript entry. */
    getEntry(entryId: string): ShellTranscriptEntry | undefined {
        return this.transcript.find(entry => entry.id === entryId);
    }

    /** Clears the transcript. */
    clearTranscript(): void {
        this.transcript.length = 0;
    }

    /**
     * Classifies a submitted command. An allow-list, never a deny-list: anything
     * unrecognised is refused rather than permitted.
     */
    classify(input: string): { classification: ShellCommandClassification; commandName?: string; } {
        const trimmed = (input ?? '').trim();

        if (!trimmed) {
            return { classification: ShellCommandClassification.Unclassifiable };
        }

        let commandName: string | undefined;

        try {
            const parsed = parseExtendedJsonObject(trimmed, 'command');
            commandName = Object.keys(parsed)[0];
        } catch {
            return { classification: ShellCommandClassification.Unclassifiable };
        }

        if (!commandName) {
            return { classification: ShellCommandClassification.Unclassifiable };
        }

        if (READ_ONLY_SHELL_COMMANDS.includes(commandName)) {
            return { classification: ShellCommandClassification.ReadOnly, commandName };
        }

        if (WRITE_SHELL_COMMANDS.includes(commandName)) {
            return { classification: ShellCommandClassification.Write, commandName };
        }

        return { classification: ShellCommandClassification.Unclassifiable, commandName };
    }

    /**
     * Executes a command.
     *
     * A read-only command runs for any actor, because reading is permitted. A write
     * or unclassifiable command requires the user actor, so an AI must stage it as a
     * proposal instead.
     */
    async execute(
        connection: LiveConnection,
        request: ShellExecuteRequest,
        actor: OperationActor
    ): Promise<ShellTranscriptEntry> {
        if (request.tier === ShellTier.Mongosh) {
            throw new UnclassifiableCommandError(
                'The full mongosh tier is not available. It cannot share this connection, and its ' +
                'JavaScript cannot be classified as read-only, so it is never executed on behalf of an AI.'
            );
        }

        const { classification, commandName } = this.classify(request.input);

        const entry: ShellTranscriptEntry = {
            id: newId(),
            connectionId: request.connectionId,
            databaseName: request.databaseName,
            input: request.input,
            tier: request.tier,
            classification,
            actor: actor === 'mcp' ? 'mcp' : 'user',
            submittedAt: nowIso(),
            status: 'pending',
        };

        this.append(entry);

        if (classification === ShellCommandClassification.Unclassifiable) {
            return this.refuse(
                entry,
                commandName
                    ? `'${commandName}' is not on the read-only allow-list and is not a recognised write command. Unrecognised commands are refused.`
                    : 'The input could not be parsed as a command document. Tier A expects Extended JSON, for example { "collStats": "myCollection" }.'
            );
        }

        if (classification === ShellCommandClassification.Write) {
            try {
                assertUserActor(actor, `shell:${commandName}`);
            } catch (error) {
                return this.refuse(entry, errorMessage(error));
            }

            if (connection.isReadOnly) {
                return this.refuse(entry, new ReadOnlyConnectionError(connection.connectionName).message);
            }
        }

        const startedAt = Date.now();

        try {
            const command = parseExtendedJsonObject(request.input, 'command');
            const withBudget: Document = { ...command, maxTimeMS: this.resolveTimeMs(request.maxTimeMs) };
            const result = await connection.runCommand(request.databaseName, withBudget);

            return this.complete(entry, {
                status: 'succeeded',
                resultJson: toExtendedJson(result),
                durationMs: Date.now() - startedAt,
            });
        } catch (error) {
            return this.complete(entry, {
                status: 'failed',
                error: redactText(errorMessage(error)),
                durationMs: Date.now() - startedAt,
            });
        }
    }

    /** Appends an entry and publishes it. */
    private append(entry: ShellTranscriptEntry): void {
        this.transcript.push(entry);

        if (this.transcript.length > 200) {
            this.transcript.shift();
        }

        this.entryChanges.next(entry);
    }

    /** Marks an entry refused and publishes the change. */
    private refuse(entry: ShellTranscriptEntry, reason: string): ShellTranscriptEntry {
        return this.complete(entry, { status: 'refused', error: reason, durationMs: 0 });
    }

    /** Applies a terminal state to an entry and publishes it. */
    private complete(
        entry: ShellTranscriptEntry,
        update: Partial<Pick<ShellTranscriptEntry, 'status' | 'resultJson' | 'error' | 'durationMs'>>
    ): ShellTranscriptEntry {
        Object.assign(entry, update);
        this.entryChanges.next(entry);
        return entry;
    }
}
