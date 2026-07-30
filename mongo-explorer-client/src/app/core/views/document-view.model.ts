import { InputSignal, OutputEmitterRef, Signal, Type } from '@angular/core';
import { Document } from 'mongodb';
import { FieldDescriptor } from '../../../model/shared-models/explorer/bson-type.model';
import { FieldActivation } from '../cells/cell-renderer.model';

/** What a view can do, so the shell can enable or disable surrounding controls. */
export interface DocumentViewCapabilities {
    /** Supports in-place editing of values. */
    readonly canEdit: boolean;

    /** Supports document selection. */
    readonly canSelect: boolean;

    /** Supports multi-selection. */
    readonly canMultiSelect: boolean;

    /** Virtualises, and so tolerates large pages. */
    readonly virtualizes: boolean;

    /** Renders deeply nested documents without flattening them. */
    readonly handlesNesting: boolean;
}

/** The context a view is asked to present. */
export interface CollectionViewContext {
    /** Connection being browsed. */
    readonly connectionId: string;

    /** Target Database name. */
    readonly databaseName: string;

    /** Collection name. */
    readonly collectionName: string;

    /** Whether writes are forbidden through this connection. */
    readonly isReadOnly: boolean;
}

/** What the shell hands a view. The shell owns data; views own presentation. */
export interface DocumentViewInputs {
    /** The documents to present, already fetched and paginated by the shell. */
    readonly documents: Document[];

    /** Field descriptors derived from the page, for column derivation. */
    readonly fields: FieldDescriptor[];

    /** Identifiers of the selected documents. Any BSON type. */
    readonly selectedIds: readonly unknown[];

    /** Whether editing is permitted. */
    readonly isReadOnly: boolean;
}

/**
 * The contract every registered view implements.
 *
 * A view receives documents as an input and emits intent. It never calls an API
 * client, never paginates, and never queries — which is what keeps adding the fourth
 * view cheap, because the expensive part is already solved once.
 */
export interface IDocumentView {
    /** The documents and selection to present. */
    readonly inputs: InputSignal<DocumentViewInputs>;

    /** Emits when the user changes the selection. */
    readonly selectionChange: OutputEmitterRef<readonly unknown[]>;

    /** Emits when the user asks to edit a document. */
    readonly editRequested: OutputEmitterRef<Document>;

    /** Emits the field the user acted on, for the shell to open a menu against. */
    readonly fieldActivated: OutputEmitterRef<FieldActivation>;
}

/**
 * The outputs the view host subscribes to.
 *
 * Every member is optional: a view is free to implement only what it supports, and the
 * host wires up whatever it finds rather than demanding the full set.
 */
export type DocumentViewOutputs = Partial<Pick<IDocumentView, 'selectionChange' | 'editRequested' | 'fieldActivated'>>;

/** A way of presenting a set of Target Database documents. */
export interface DocumentViewDescriptor {
    /** Stable identifier, for example 'table', 'json', or 'list'. */
    readonly id: string;

    /** Display label. */
    readonly label: string;

    /** Icon class. */
    readonly icon: string;

    /** Sort order in the view switcher. */
    readonly order: number;

    /** The component rendered for this view. */
    readonly component: Type<unknown>;

    /** Whether this view can present the given context at all. */
    supports(context: CollectionViewContext): boolean;

    /** What the view can do. */
    readonly capabilities: DocumentViewCapabilities;
}

/** Shell-owned view state, so switching views does not lose the user's place. */
export interface CollectionViewState {
    /** Which registered view is active. */
    viewId: string;

    /** Filter as Extended JSON text. */
    filter: string;

    /** Projection as Extended JSON text. */
    projection: string;

    /** Sort as Extended JSON text. */
    sort: string;

    /** Page size. */
    limit: number;

    /** Documents skipped. */
    skip: number;

    /** Column paths the user has hidden. */
    hiddenColumns: string[];

    /** Explicit column order, when the user has reordered them. */
    columnOrder: string[];
}

/** A fresh view state. */
export function createDefaultViewState(): CollectionViewState {
    return {
        viewId: 'table',
        filter: '',
        projection: '',
        sort: '',
        limit: 50,
        skip: 0,
        hiddenColumns: [],
        columnOrder: [],
    };
}

/** Signal-typed accessor used by views that read their inputs reactively. */
export type ViewInputsSignal = Signal<DocumentViewInputs>;
