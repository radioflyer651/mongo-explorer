import { CommonModule } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { CellContext } from '../../../core/cells/cell-renderer.model';
import { bsonTypeColorVariable, summariseValue } from '../../../core/ejson.util';
import { ComponentBase } from '../../component-base/component-base.component';

/** Renders a scalar value with its BSON type colour and an in-cell copy button. */
@Component({
    selector: 'app-value-cell',
    imports: [CommonModule],
    templateUrl: './value-cell.component.html',
    styleUrl: './value-cell.component.scss',
})
export class ValueCellComponent extends ComponentBase {
    constructor() {
        super();
    }

    /** What to render. */
    readonly context = input.required<CellContext>();

    /** The display text. */
    readonly display = computed(() => summariseValue(this.context().value, this.context().bsonType));

    /** The CSS custom property carrying this type's colour. */
    readonly colorVariable = computed(() => `var(${bsonTypeColorVariable(this.context().bsonType)})`);

    /** True for types worth labelling, so a lossy number is not mistaken for an integer. */
    readonly showTypeBadge = computed(() => ['decimal', 'long', 'double', 'timestamp'].includes(this.context().bsonType));

    /** Whether the value is long enough to need truncation. */
    readonly isLong = computed(() => this.display().length > 120);

    /** Copies the value to the clipboard. */
    async copy(event: MouseEvent): Promise<void> {
        event.stopPropagation();
        await navigator.clipboard.writeText(this.display());
    }
}
