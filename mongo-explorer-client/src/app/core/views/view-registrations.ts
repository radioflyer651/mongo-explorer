import { inject } from '@angular/core';
import { ViewRegistry } from './view-registry.service';
import { DocumentViewDescriptor } from './document-view.model';
import { TableViewComponent } from '../../components/views/table-view/table-view.component';
import { JsonViewComponent } from '../../components/views/json-view/json-view.component';
import { ListViewComponent } from '../../components/views/list-view/list-view.component';
import { ICONS } from '../icons';

/**
 * Registers the document views.
 *
 * Adding a view is a descriptor plus a component — the shell does not change and
 * there is no switch statement to extend.
 */
export function registerDocumentViews(): void {
    const registry = inject(ViewRegistry);

    const views: DocumentViewDescriptor[] = [
        {
            id: 'table',
            label: 'Table',
            icon: ICONS.viewTable,
            order: 10,
            component: TableViewComponent,
            supports: () => true,
            capabilities: {
                canEdit: true,
                canSelect: true,
                canMultiSelect: true,
                virtualizes: false,
                handlesNesting: false,
            },
        },
        {
            id: 'json',
            label: 'JSON',
            icon: ICONS.viewJson,
            order: 20,
            component: JsonViewComponent,
            supports: () => true,
            capabilities: {
                canEdit: true,
                canSelect: true,
                canMultiSelect: false,
                virtualizes: false,
                handlesNesting: true,
            },
        },
        {
            id: 'list',
            label: 'List',
            icon: ICONS.viewList,
            order: 30,
            component: ListViewComponent,
            supports: () => true,
            capabilities: {
                canEdit: true,
                canSelect: true,
                canMultiSelect: false,
                virtualizes: false,
                handlesNesting: true,
            },
        },
    ];

    registry.registerAll(views);
}
