import { CommonModule } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { CellContext } from '../../../core/cells/cell-renderer.model';
import { ComponentBase } from '../../component-base/component-base.component';

/**
 * Renders a null value or an absent field.
 *
 * These are deliberately distinct. In MongoDB a null value and a missing field are
 * different things, and the interface must never imply otherwise — a user who cannot
 * tell them apart will write the wrong filter.
 */
@Component({
    selector: 'app-null-cell',
    imports: [CommonModule],
    templateUrl: './null-cell.component.html',
    styleUrl: './null-cell.component.scss',
})
export class NullCellComponent extends ComponentBase {
    constructor() {
        super();
    }

    /** What to render. */
    readonly context = input.required<CellContext>();

    /** True when the field is missing rather than explicitly null. */
    readonly isAbsent = computed(() => this.context().bsonType === 'absent');

    /** Explanation shown on hover, since the visual difference is subtle. */
    readonly explanation = computed(() =>
        this.isAbsent()
            ? `The field '${this.context().path}' is not present in this document. This is not the same as null.`
            : `The field '${this.context().path}' is explicitly null. This is not the same as being absent.`
    );
}
