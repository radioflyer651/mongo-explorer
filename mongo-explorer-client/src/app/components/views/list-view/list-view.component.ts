import { CommonModule } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { CellHostComponent } from '../../cells/cell-host/cell-host.component';
import { ComponentBase } from '../../component-base/component-base.component';
import { DocumentViewInputs } from '../../../core/views/document-view.model';
import { CellContext, FieldActivation } from '../../../core/cells/cell-renderer.model';
import { getBsonTypeName, readPath, toExtendedJson } from '../../../core/ejson.util';

/** One document rendered as a labelled field list. */
interface ListEntry {
    /** Stable key. */
    key: string;

    /** The document's identifier, for selection. */
    id: unknown;

    /** The document itself. */
    document: Record<string, unknown>;

    /** Field paths to show. */
    paths: string[];
}

/**
 * List view. One block per document with labelled fields, which reads better than a
 * table for wide documents and for documents whose fields differ from each other.
 */
@Component({
    selector: 'app-list-view',
    imports: [CommonModule, CellHostComponent],
    templateUrl: './list-view.component.html',
    styleUrl: './list-view.component.scss',
})
export class ListViewComponent extends ComponentBase {
    constructor() {
        super();
    }

    /** The documents and selection to present. */
    readonly inputs = input.required<DocumentViewInputs>();

    /** Emits when the user changes the selection. */
    readonly selectionChange = output<readonly unknown[]>();

    /** Emits when the user asks to edit a document. */
    readonly editRequested = output<Record<string, unknown>>();

    /** Emits a field context when the user right-clicks a field. */
    readonly fieldActivated = output<FieldActivation>();

    /** The documents, each with its own field list. */
    readonly entries = computed<ListEntry[]>(() =>
        this.inputs().documents.map(document => ({
            key: toExtendedJson(document['_id'] ?? document).slice(0, 64),
            id: document['_id'],
            document,
            /* Per-document keys rather than derived columns: this view exists
               precisely for documents whose shapes differ. */
            paths: Object.keys(document),
        }))
    );

    /** Builds the cell context for one field. */
    cellContext(document: Record<string, unknown>, path: string): CellContext {
        const value = readPath(document, path);

        return {
            path,
            value,
            bsonType: getBsonTypeName(value),
            document,
            isReadOnly: this.inputs().isReadOnly,
        };
    }

    /** Whether an entry is selected. */
    isSelected(entry: ListEntry): boolean {
        const key = toExtendedJson(entry.id);
        return this.inputs().selectedIds.some(id => toExtendedJson(id) === key);
    }

    /** Selects one entry. */
    select(entry: ListEntry): void {
        this.selectionChange.emit(this.isSelected(entry) ? [] : [entry.id]);
    }

    /** Raises a field context for the shell to open a menu against. */
    activateField(document: Record<string, unknown>, path: string, event: MouseEvent): void {
        event.preventDefault();
        this.fieldActivated.emit({
            cell: this.cellContext(document, path),
            position: { x: event.clientX, y: event.clientY },
        });
    }
}
