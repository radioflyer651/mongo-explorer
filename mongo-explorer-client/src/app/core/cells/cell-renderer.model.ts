import { Type } from '@angular/core';
import { BsonTypeName } from '../../../model/shared-models/explorer/bson-type.model';

/** What a cell is being asked to render. */
export interface CellContext {
    /** Dotted field path. */
    readonly path: string;

    /** The value. May be undefined, meaning the field is absent. */
    readonly value: unknown;

    /** The BSON type, with null and absent reported distinctly. */
    readonly bsonType: BsonTypeName;

    /** The document the value came from, for context-aware affordances. */
    readonly document: Record<string, unknown>;

    /** Whether editing is permitted. */
    readonly isReadOnly: boolean;
}

/**
 * A field the user has acted on, and where the pointer was.
 *
 * The position travels with the context because the shell opens the menu but only the
 * view saw the event — without it the menu lands in the corner of the window.
 */
export interface FieldActivation {
    /** The field acted on. */
    readonly cell: CellContext;

    /** Where the pointer was, in viewport coordinates. */
    readonly position: { readonly x: number; readonly y: number; };
}

/** Renders a single field value inside a grid cell. */
export interface ICellRenderer {
    /** Stable identifier. */
    readonly id: string;

    /** Higher wins when several renderers match. */
    readonly priority: number;

    /** Whether this renderer handles the given value. */
    matches(context: CellContext): boolean;

    /** The component rendered for a matching value. */
    readonly component: Type<unknown>;
}

/** Inputs handed to a cell renderer component. */
export interface CellRendererInputs {
    /** What to render. */
    readonly context: CellContext;
}
