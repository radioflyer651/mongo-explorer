import { CommonModule } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { CellRendererRegistry } from '../../../core/cells/cell-renderer-registry.service';
import { CellContext } from '../../../core/cells/cell-renderer.model';
import { ComponentBase } from '../../component-base/component-base.component';

/**
 * Renders one cell by resolving the registered renderer for its value.
 *
 * There is deliberately no chain of type checks here — adding a type affordance is a
 * registration, not another branch in this template.
 */
@Component({
    selector: 'app-cell-host',
    imports: [CommonModule],
    templateUrl: './cell-host.component.html',
    styleUrl: './cell-host.component.scss',
})
export class CellHostComponent extends ComponentBase {
    constructor() {
        super();
    }

    private readonly registry = inject(CellRendererRegistry);

    /** What to render. */
    readonly context = input.required<CellContext>();

    /** The component chosen for this value. */
    readonly renderer = computed(() => this.registry.rendererFor(this.context())?.component);

    /** Inputs handed to the chosen component. */
    readonly rendererInputs = computed(() => ({ context: this.context() }));
}
