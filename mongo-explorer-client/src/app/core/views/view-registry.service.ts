import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { CollectionViewContext, DocumentViewDescriptor } from './document-view.model';

/**
 * ◈ View Registry: a new view is a descriptor plus a component. No shell changes and
 * no switch statement to extend.
 *
 * No view is privileged. The table view is the default, not a base class, and nothing
 * in the shell may assume rows and columns.
 */
@Injectable({ providedIn: 'root' })
export class ViewRegistry {
    private readonly views = new Map<string, DocumentViewDescriptor>();
    private readonly _changed = new BehaviorSubject<number>(0);

    /** Emits whenever the registered set changes. */
    readonly changed$: Observable<number> = this._changed.asObservable();

    /** Registers a view. */
    register(descriptor: DocumentViewDescriptor): void {
        this.views.set(descriptor.id, descriptor);
        this._changed.next(this._changed.value + 1);
    }

    /** Registers several views at once. */
    registerAll(descriptors: readonly DocumentViewDescriptor[]): void {
        descriptors.forEach(descriptor => this.views.set(descriptor.id, descriptor));
        this._changed.next(this._changed.value + 1);
    }

    /** Looks up one view. */
    get(viewId: string): DocumentViewDescriptor | undefined {
        return this.views.get(viewId);
    }

    /** Every registered view, in display order. */
    get all(): DocumentViewDescriptor[] {
        return [...this.views.values()].sort((first, second) => first.order - second.order);
    }

    /** The views that can present a given context. */
    viewsFor(context: CollectionViewContext): DocumentViewDescriptor[] {
        return this.all.filter(view => {
            try {
                return view.supports(context);
            } catch {
                return false;
            }
        });
    }

    /**
     * Resolves a requested view, falling back to the first supported one. Returns
     * undefined only when nothing can present the context at all.
     */
    resolveFor(context: CollectionViewContext, requestedViewId: string | undefined): DocumentViewDescriptor | undefined {
        const supported = this.viewsFor(context);

        if (requestedViewId) {
            const requested = supported.find(view => view.id === requestedViewId);

            if (requested) {
                return requested;
            }
        }

        return supported[0];
    }
}
