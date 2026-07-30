import { injectable } from 'inversify';
import { Observable, Subject } from 'rxjs';
import { ActivityActor, ActivityEntry } from '../model/shared-models/mcp/app-session-state.model';
import { newId, nowIso } from '../utils/misc.util';

/**
 * The attribution log.
 *
 * The mode switch answers "stop entirely". This answers the subtler question — did I
 * do that, or did the AI? Every AI-originated change is recorded and individually
 * reversible.
 */
@injectable()
export class ActivityService {
    constructor(limit: number) {
        this.limit = limit;
    }

    private readonly limit: number;
    private readonly entries: ActivityEntry[] = [];
    private readonly appended = new Subject<ActivityEntry>();

    /** Emits whenever an entry is appended. */
    readonly appended$: Observable<ActivityEntry> = this.appended.asObservable();

    /** Records an action, newest last. */
    record(entry: {
        actor: ActivityActor;
        action: string;
        description: string;
        isUndoable?: boolean;
        undoPayload?: string;
    }): ActivityEntry {
        const created: ActivityEntry = {
            id: newId(),
            at: nowIso(),
            actor: entry.actor,
            action: entry.action,
            description: entry.description,
            isUndoable: entry.isUndoable ?? false,
            isUndone: false,
            undoPayload: entry.undoPayload,
        };

        this.entries.push(created);

        while (this.entries.length > this.limit) {
            this.entries.shift();
        }

        this.appended.next(created);
        return created;
    }

    /** Returns recent entries, newest first. */
    getRecent(limit = 100): ActivityEntry[] {
        return [...this.entries].reverse().slice(0, limit);
    }

    /** Returns one entry. */
    getEntry(entryId: string): ActivityEntry | undefined {
        return this.entries.find(entry => entry.id === entryId);
    }

    /** The most recent undoable, not-yet-undone AI-originated entry. */
    getLastUndoableAiEntry(): ActivityEntry | undefined {
        for (let index = this.entries.length - 1; index >= 0; index -= 1) {
            const entry = this.entries[index];

            if (entry.actor === 'mcp' && entry.isUndoable && !entry.isUndone) {
                return entry;
            }
        }

        return undefined;
    }

    /** Marks an entry as undone. */
    markUndone(entryId: string): void {
        const entry = this.getEntry(entryId);

        if (entry) {
            (entry as { isUndone: boolean; }).isUndone = true;
        }
    }
}
