import { CommonModule } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { ComponentBase } from '../../component-base/component-base.component';
import { DocumentViewInputs } from '../../../core/views/document-view.model';
import { toDisplayJson, toExtendedJson } from '../../../core/ejson.util';

/** One document rendered as Extended JSON. */
interface JsonEntry {
    /** Stable key. */
    key: string;

    /** The document's identifier, for selection. */
    id: unknown;

    /** Readable Extended JSON. */
    json: string;
}

/**
 * JSON view. Renders each document as canonical Extended JSON, so BSON types are
 * visible rather than flattened into JavaScript approximations.
 */
@Component({
    selector: 'app-json-view',
    imports: [CommonModule],
    templateUrl: './json-view.component.html',
    styleUrl: './json-view.component.scss',
})
export class JsonViewComponent extends ComponentBase {
    constructor() {
        super();
    }

    /** The documents and selection to present. */
    readonly inputs = input.required<DocumentViewInputs>();

    /** Emits when the user changes the selection. */
    readonly selectionChange = output<readonly unknown[]>();

    /** Emits when the user asks to edit a document. */
    readonly editRequested = output<Record<string, unknown>>();

    /** The documents, serialised for display. */
    readonly entries = computed<JsonEntry[]>(() =>
        this.inputs().documents.map(document => ({
            key: toExtendedJson(document['_id'] ?? document).slice(0, 64),
            id: document['_id'],
            json: toDisplayJson(document),
        }))
    );

    /** Whether an entry is selected. */
    isSelected(entry: JsonEntry): boolean {
        const key = toExtendedJson(entry.id);
        return this.inputs().selectedIds.some(id => toExtendedJson(id) === key);
    }

    /** Selects one entry. */
    select(entry: JsonEntry): void {
        this.selectionChange.emit(this.isSelected(entry) ? [] : [entry.id]);
    }

    /** Copies one document as Extended JSON. */
    async copy(entry: JsonEntry, event: MouseEvent): Promise<void> {
        event.stopPropagation();
        await navigator.clipboard.writeText(entry.json);
    }

    /** Raises an edit request for one document. */
    edit(index: number, event: MouseEvent): void {
        event.stopPropagation();
        this.editRequested.emit(this.inputs().documents[index]);
    }
}
