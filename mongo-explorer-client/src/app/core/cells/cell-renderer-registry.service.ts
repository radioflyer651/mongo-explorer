import { Injectable } from '@angular/core';
import { CellContext, ICellRenderer } from './cell-renderer.model';

/**
 * ◈ Cell Renderer Registry: adding a type affordance is a registration, not another
 * branch in a template.
 *
 * The intent document requires cells to host widgets and buttons, which means cell
 * rendering has to be extensible in the same way views are.
 */
@Injectable({ providedIn: 'root' })
export class CellRendererRegistry {
    private readonly renderers: ICellRenderer[] = [];

    /** Registers a renderer. */
    register(renderer: ICellRenderer): void {
        const existing = this.renderers.findIndex(candidate => candidate.id === renderer.id);

        if (existing >= 0) {
            this.renderers.splice(existing, 1);
        }

        this.renderers.push(renderer);
        this.renderers.sort((first, second) => second.priority - first.priority);
    }

    /** Registers several renderers at once. */
    registerAll(renderers: readonly ICellRenderer[]): void {
        renderers.forEach(renderer => this.register(renderer));
    }

    /** Every registered renderer, highest priority first. */
    get all(): ICellRenderer[] {
        return [...this.renderers];
    }

    /**
     * Picks the renderer for a value. Returns undefined only when nothing matches,
     * which the fallback renderer registration is expected to prevent.
     */
    rendererFor(context: CellContext): ICellRenderer | undefined {
        return this.renderers.find(renderer => {
            try {
                return renderer.matches(context);
            } catch {
                return false;
            }
        });
    }
}
