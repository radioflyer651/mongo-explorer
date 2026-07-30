import { CommonModule } from '@angular/common';
import {
    Component,
    ComponentRef,
    OutputRefSubscription,
    Type,
    ViewContainerRef,
    computed,
    effect,
    inject,
    input,
    output,
    untracked,
    viewChild,
} from '@angular/core';
import { ViewRegistry } from '../../../core/views/view-registry.service';
import {
    CollectionViewContext,
    DocumentViewInputs,
    DocumentViewOutputs,
} from '../../../core/views/document-view.model';
import { FieldActivation } from '../../../core/cells/cell-renderer.model';
import { ComponentBase } from '../../component-base/component-base.component';

/**
 * Renders whichever view is active.
 *
 * The shell owns the data; the view owns presentation only. There is deliberately no
 * switch on the view id here — that would be exactly the lock-in the registry exists
 * to prevent.
 *
 * ⚠ The view is created imperatively rather than with `*ngComponentOutlet`, because that
 * directive can bind a dynamic component's inputs but has no way to bind its
 * **outputs**. Attempting it silently drops every event the view emits, which is how
 * selection and the field context menu came to do nothing at all.
 */
@Component({
    selector: 'app-view-host',
    imports: [CommonModule],
    templateUrl: './view-host.component.html',
    styleUrl: './view-host.component.scss',
})
export class ViewHostComponent extends ComponentBase {
    constructor() {
        super();

        /* Recreate only when the resolved component changes. The inputs are read
           untracked so that a new page of documents re-binds rather than rebuilding
           the view and discarding its scroll position and internal state. */
        effect(() => {
            const component = this.component();
            this.render(this.viewOutlet(), component);
        });

        /* Re-bind inputs on every data change. */
        effect(() => {
            const inputs = this.viewInputs();
            this.viewRef?.setInput('inputs', inputs);
        });
    }

    private readonly registry = inject(ViewRegistry);

    /** Where the active view is created. */
    private readonly viewOutlet = viewChild.required('viewOutlet', { read: ViewContainerRef });

    /** The live view, when one is rendered. */
    private viewRef?: ComponentRef<DocumentViewOutputs>;

    /** Subscriptions to the live view's outputs, dropped when it is replaced. */
    private outputSubscriptions: OutputRefSubscription[] = [];

    /** Which collection is being presented. */
    readonly viewContext = input.required<CollectionViewContext>();

    /** Which registered view to use. */
    readonly viewId = input.required<string>();

    /** What to present. */
    readonly viewInputs = input.required<DocumentViewInputs>();

    /** Emits when the active view changes the selection. */
    readonly selectionChange = output<readonly unknown[]>();

    /** Emits when the active view requests a document edit. */
    readonly editRequested = output<Record<string, unknown>>();

    /** Emits when the active view raises a field context. */
    readonly fieldActivated = output<FieldActivation>();

    /** The resolved view descriptor. */
    readonly descriptor = computed(() => this.registry.resolveFor(this.viewContext(), this.viewId()));

    /** The component to render. */
    readonly component = computed(() => this.descriptor()?.component);

    /** Creates the view and wires whichever outputs it declares. */
    private render(container: ViewContainerRef, component: Type<unknown> | undefined): void {
        this.releaseView();
        container.clear();

        if (!component) {
            return;
        }

        const reference = container.createComponent(component) as ComponentRef<DocumentViewOutputs>;
        reference.setInput('inputs', untracked(() => this.viewInputs()));

        const instance = reference.instance;

        /* A view implements only the outputs it supports, so each is wired if present
           rather than required. */
        this.outputSubscriptions = [
            instance.selectionChange?.subscribe(ids => this.selectionChange.emit(ids)),
            instance.editRequested?.subscribe(document => this.editRequested.emit(document)),
            instance.fieldActivated?.subscribe(activation => this.fieldActivated.emit(activation)),
        ].filter((subscription): subscription is OutputRefSubscription => !!subscription);

        this.viewRef = reference;
    }

    /** Drops the live view's subscriptions and destroys it. */
    private releaseView(): void {
        this.outputSubscriptions.forEach(subscription => subscription.unsubscribe());
        this.outputSubscriptions = [];
        this.viewRef?.destroy();
        this.viewRef = undefined;
    }

    override ngOnDestroy(): void {
        this.releaseView();
        super.ngOnDestroy();
    }
}
