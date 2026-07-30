import { Injectable, signal } from '@angular/core';
import { CommandContext } from './app-command.model';

/** Viewport coordinates the menu should open at. */
export interface MenuPosition {
    /** Distance from the viewport's left edge, in pixels. */
    readonly x: number;

    /** Distance from the viewport's top edge, in pixels. */
    readonly y: number;
}

/** An open context menu: what it acts on, and where it sits. */
export interface ContextMenuRequest {
    /** What the commands will act on. */
    readonly context: CommandContext;

    /** Where to draw the menu. */
    readonly position: MenuPosition;
}

/**
 * Holds the one open context menu.
 *
 * There is a single `<app-command-menu>` in the shell, so there must be a single place
 * that says what it is showing. A surface that keeps its own copy of this state raises
 * menus nobody renders — which is precisely how right-click came to do nothing.
 *
 * Surfaces call `openAt`; the shell renders `request`. Nothing else needs to know.
 */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
    private readonly _request = signal<ContextMenuRequest | undefined>(undefined);

    /** The open menu, or undefined when none is open. */
    readonly request = this._request.asReadonly();

    /**
     * Opens a menu at a pointer event, suppressing the browser's own menu.
     *
     * Both right-click and an overflow button route through here, so the two
     * affordances cannot drift apart.
     */
    openAt(context: CommandContext, event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();

        this._request.set({ context, position: this.positionOf(event) });
    }

    /** Opens a menu at explicit coordinates. */
    open(context: CommandContext, position: MenuPosition): void {
        this._request.set({ context, position });
    }

    /** Closes the menu. */
    close(): void {
        this._request.set(undefined);
    }

    /**
     * Reads the pointer position from an event.
     *
     * A keyboard-invoked context menu reports 0,0 for the pointer, so the target
     * element's own corner is used instead — otherwise the menu lands in the top-left
     * of the window, far from what it acts on.
     */
    private positionOf(event: MouseEvent): MenuPosition {
        if (event.clientX !== 0 || event.clientY !== 0) {
            return { x: event.clientX, y: event.clientY };
        }

        const target = event.target;

        if (target instanceof Element) {
            const bounds = target.getBoundingClientRect();
            return { x: bounds.left, y: bounds.bottom };
        }

        return { x: 0, y: 0 };
    }
}
