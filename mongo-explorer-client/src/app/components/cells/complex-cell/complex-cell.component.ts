import { CommonModule } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import { CellContext } from '../../../core/cells/cell-renderer.model';
import { toDisplayJson } from '../../../core/ejson.util';
import { ComponentBase } from '../../component-base/component-base.component';

/**
 * Renders a subdocument, array, or binary value as a summary with an expander.
 *
 * Binary values never dump their bytes into a cell: that destroys the grid and helps
 * nobody.
 */
@Component({
    selector: 'app-complex-cell',
    imports: [CommonModule],
    templateUrl: './complex-cell.component.html',
    styleUrl: './complex-cell.component.scss',
})
export class ComplexCellComponent extends ComponentBase {
    constructor() {
        super();
    }

    /** What to render. */
    readonly context = input.required<CellContext>();

    /** Whether the expanded body is showing. */
    readonly isExpanded = signal(false);

    /** Short summary shown when collapsed. */
    readonly summary = computed(() => {
        const { value, bsonType } = this.context();

        if (bsonType === 'binData') {
            const length = (value as { length?: () => number; buffer?: { length: number; }; })?.buffer?.length ?? 0;
            return `binary, ${length} byte${length === 1 ? '' : 's'}`;
        }

        if (bsonType === 'array') {
            const items = Array.isArray(value) ? value : [];
            return `${items.length} item${items.length === 1 ? '' : 's'}`;
        }

        const keys = Object.keys((value as Record<string, unknown>) ?? {});
        return `${keys.length} field${keys.length === 1 ? '' : 's'}`;
    });

    /** A preview of the first element, for arrays. */
    readonly preview = computed(() => {
        const { value, bsonType } = this.context();

        if (bsonType !== 'array' || !Array.isArray(value) || value.length === 0) {
            return '';
        }

        const first = toDisplayJson(value[0], 0);
        return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    });

    /** Whether an expander is worth offering. */
    readonly canExpand = computed(() => this.context().bsonType !== 'binData');

    /** The full value as readable Extended JSON. */
    readonly expandedJson = computed(() => toDisplayJson(this.context().value));

    /** Toggles the expanded body. */
    toggle(event: MouseEvent): void {
        event.stopPropagation();
        this.isExpanded.update(current => !current);
    }
}
