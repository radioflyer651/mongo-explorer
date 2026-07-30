import { CommonModule } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { TableModule } from 'primeng/table';
import { CellHostComponent } from '../../cells/cell-host/cell-host.component';
import { ComponentBase } from '../../component-base/component-base.component';
import { DocumentViewInputs } from '../../../core/views/document-view.model';
import { CellContext, FieldActivation } from '../../../core/cells/cell-renderer.model';
import { getBsonTypeName, readPath, toExtendedJson } from '../../../core/ejson.util';

/** One derived column. */
interface DerivedColumn {
    /** Dotted field path. */
    path: string;

    /** How many sampled documents carried this field. */
    presentCount: number;

    /** How many documents were sampled. */
    sampleSize: number;
}

/**
 * Table view. The default view, not a base class — nothing in the shell may assume
 * rows and columns.
 *
 * Columns are derived from the loaded page, so the column set is a hypothesis about
 * schemaless data. The header shows how many documents carried each field so the user
 * knows the list is inferred rather than declared.
 */
@Component({
    selector: 'app-table-view',
    imports: [CommonModule, TableModule, CellHostComponent],
    templateUrl: './table-view.component.html',
    styleUrl: './table-view.component.scss',
})
export class TableViewComponent extends ComponentBase {
    constructor() {
        super();
    }

    /** The documents and selection to present. */
    readonly inputs = input.required<DocumentViewInputs>();

    /** Emits when the user changes the selection. */
    readonly selectionChange = output<readonly unknown[]>();

    /** Emits when the user asks to edit a document. */
    readonly editRequested = output<Record<string, unknown>>();

    /** Emits a field context when the user right-clicks a cell. */
    readonly fieldActivated = output<FieldActivation>();

    /** Columns derived from the page, most frequently present first. */
    readonly columns = computed<DerivedColumn[]>(() =>
        this.inputs()
            .fields.filter(field => !field.path.includes('.'))
            .map(field => ({
                path: field.path,
                presentCount: field.presentCount,
                sampleSize: field.sampleSize,
            }))
    );

    /** The documents to render. */
    readonly documents = computed(() => this.inputs().documents);

    /** Builds the cell context for one document and column. */
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

    /** A stable row key, tolerating any BSON type of identifier. */
    rowKey(document: Record<string, unknown>): string {
        const id = document['_id'];
        return id === undefined ? toExtendedJson(document).slice(0, 64) : toExtendedJson(id);
    }

    /** Whether a row is selected. */
    isSelected(document: Record<string, unknown>): boolean {
        const key = this.rowKey(document);
        return this.inputs().selectedIds.some(id => toExtendedJson(id) === key);
    }

    /** Toggles a row's selection. */
    toggleRow(document: Record<string, unknown>, event: MouseEvent): void {
        const id = document['_id'];
        const current = [...this.inputs().selectedIds];
        const key = toExtendedJson(id);
        const index = current.findIndex(candidate => toExtendedJson(candidate) === key);

        if (event.ctrlKey || event.metaKey) {
            if (index >= 0) {
                current.splice(index, 1);
            } else {
                current.push(id);
            }

            this.selectionChange.emit(current);
            return;
        }

        this.selectionChange.emit(index >= 0 && current.length === 1 ? [] : [id]);
    }

    /** Raises a field context for the shell to open a menu against. */
    activateField(document: Record<string, unknown>, path: string, event: MouseEvent): void {
        event.preventDefault();
        this.fieldActivated.emit({
            cell: this.cellContext(document, path),
            position: { x: event.clientX, y: event.clientY },
        });
    }

    /** Column header tooltip stating how confident the derivation is. */
    columnTitle(column: DerivedColumn): string {
        return `${column.path} — present in ${column.presentCount} of ${column.sampleSize} loaded documents`;
    }

    /** True when a column is absent from some loaded documents. */
    isPartialColumn(column: DerivedColumn): boolean {
        return column.presentCount < column.sampleSize;
    }
}
