import { Routes } from '@angular/router';

/**
 * A single flat routes definition.
 *
 * The workspace is one screen with tabs rather than a navigable hierarchy, so the
 * route tree is deliberately shallow. It exists so deep links to a collection can be
 * added later without restructuring.
 */
export const routes: Routes = [
    {
        path: '',
        children: [],
    },
    {
        path: '**',
        redirectTo: '',
    },
];
