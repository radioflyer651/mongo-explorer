import { inject } from '@angular/core';
import { CellRendererRegistry } from './cell-renderer-registry.service';
import { ICellRenderer } from './cell-renderer.model';
import { ValueCellComponent } from '../../components/cells/value-cell/value-cell.component';
import { NullCellComponent } from '../../components/cells/null-cell/null-cell.component';
import { ComplexCellComponent } from '../../components/cells/complex-cell/complex-cell.component';

/**
 * Registers the cell renderers, highest priority first.
 *
 * Two of these matter more than they look: null and absent must be visually distinct
 * because that distinction is data, and binary must never dump bytes into a cell.
 */
export function registerCellRenderers(): void {
    const registry = inject(CellRendererRegistry);

    const renderers: ICellRenderer[] = [
        {
            id: 'null',
            priority: 100,
            matches: context => context.bsonType === 'null' || context.bsonType === 'absent',
            component: NullCellComponent,
        },
        {
            id: 'binary',
            priority: 90,
            matches: context => context.bsonType === 'binData',
            component: ComplexCellComponent,
        },
        {
            id: 'subdocument',
            priority: 80,
            matches: context => context.bsonType === 'object',
            component: ComplexCellComponent,
        },
        {
            id: 'array',
            priority: 80,
            matches: context => context.bsonType === 'array',
            component: ComplexCellComponent,
        },
        {
            /* Fallback, so rendererFor never returns undefined. */
            id: 'value',
            priority: 0,
            matches: () => true,
            component: ValueCellComponent,
        },
    ];

    registry.registerAll(renderers);
}
