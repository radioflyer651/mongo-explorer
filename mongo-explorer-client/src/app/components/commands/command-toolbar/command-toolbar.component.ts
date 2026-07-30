import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { CommandRegistry } from '../../../core/commands/command-registry.service';
import { CommandContext, ResolvedCommand } from '../../../core/commands/app-command.model';
import { ComponentBase } from '../../component-base/component-base.component';

/**
 * A toolbar is a filtered, ordered projection of the command registry.
 *
 * This component contains no behaviour: it calls execute. If it needed a special
 * case, the command's declaration would be wrong.
 */
@Component({
    selector: 'app-command-toolbar',
    imports: [CommonModule],
    templateUrl: './command-toolbar.component.html',
    styleUrl: './command-toolbar.component.scss',
})
export class CommandToolbarComponent extends ComponentBase {
    constructor(readonly registry: CommandRegistry) {
        super();
    }

    /** What the commands act on. */
    readonly context = input.required<CommandContext>();

    /** Restricts the toolbar to these command ids, in this order, when supplied. */
    readonly only = input<readonly string[] | undefined>(undefined);

    /** Whether to show labels beside the icons. */
    readonly showLabels = input(false);

    /** Emits when a command fails, so the shell can surface the reason. */
    readonly commandFailed = output<string>();

    /** The commands to render. */
    readonly commands = computed<ResolvedCommand[]>(() => {
        const resolved = this.registry.commandsFor(this.context());
        const allowed = this.only();

        if (!allowed) {
            return resolved;
        }

        return allowed
            .map(id => resolved.find(candidate => candidate.command.id === id))
            .filter((candidate): candidate is ResolvedCommand => candidate !== undefined);
    });

    /** Tooltip text: the label, the keybinding, and the reason when disabled. */
    tooltipFor(resolved: ResolvedCommand): string {
        const parts = [resolved.command.label];

        if (resolved.command.keybinding) {
            parts.push(`(${resolved.command.keybinding})`);
        }

        if (!resolved.enablement.enabled) {
            parts.push(`— ${resolved.enablement.reason}`);
        }

        return parts.join(' ');
    }

    /** Invokes a command. */
    async invoke(resolved: ResolvedCommand): Promise<void> {
        if (!resolved.enablement.enabled) {
            /* A disabled control still explains itself rather than doing nothing
               silently. */
            this.commandFailed.emit(resolved.enablement.reason);
            return;
        }

        try {
            await this.registry.execute(resolved.command.id, resolved.context);
        } catch (error) {
            this.commandFailed.emit(error instanceof Error ? error.message : 'The command failed.');
        }
    }
}
