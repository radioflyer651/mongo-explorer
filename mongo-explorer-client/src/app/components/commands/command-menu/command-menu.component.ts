import { CommonModule } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommandRegistry } from '../../../core/commands/command-registry.service';
import {
    COMMAND_GROUP_ORDER,
    CommandContext,
    CommandGroup,
    ResolvedCommand,
} from '../../../core/commands/app-command.model';
import { ComponentBase } from '../../component-base/component-base.component';

/** One rendered group of menu items. */
interface MenuGroup {
    /** The group. */
    group: CommandGroup;

    /** The commands in it. */
    commands: ResolvedCommand[];
}

/**
 * The shared context menu. Every selectable surface uses this rather than building
 * its own item list, which is how the menus and the toolbars stay in agreement.
 */
@Component({
    selector: 'app-command-menu',
    imports: [CommonModule],
    templateUrl: './command-menu.component.html',
    styleUrl: './command-menu.component.scss',
})
export class CommandMenuComponent extends ComponentBase {
    constructor(readonly registry: CommandRegistry) {
        super();
    }

    /** What the commands act on. Undefined closes the menu. */
    readonly context = input<CommandContext | undefined>(undefined);

    /** Where to position the menu, in viewport coordinates. */
    readonly position = input<{ x: number; y: number; } | undefined>(undefined);

    /** Emits when the menu should close. */
    readonly closed = output<void>();

    /** Emits when a command fails, so the shell can surface the reason. */
    readonly commandFailed = output<string>();

    /** The commands, grouped and ordered, with separators between groups. */
    readonly groups = computed<MenuGroup[]>(() => {
        const context = this.context();

        if (!context) {
            return [];
        }

        const resolved = this.registry.commandsFor(context);

        return COMMAND_GROUP_ORDER
            .map(group => ({ group, commands: resolved.filter(candidate => candidate.command.group === group) }))
            .filter(entry => entry.commands.length > 0);
    });

    /** Whether the menu has anything to show. */
    readonly isOpen = computed(() => this.context() !== undefined && this.groups().length > 0);

    /** Inline style positioning the menu at the pointer. */
    readonly menuStyle = computed(() => {
        const position = this.position();

        if (!position) {
            return {};
        }

        return { left: `${position.x}px`, top: `${position.y}px` };
    });

    /** Tooltip text carrying the reason when a command is unavailable. */
    tooltipFor(resolved: ResolvedCommand): string {
        return resolved.enablement.enabled ? resolved.command.label : resolved.enablement.reason;
    }

    /** Invokes a command and closes the menu. */
    async invoke(resolved: ResolvedCommand): Promise<void> {
        if (!resolved.enablement.enabled) {
            this.commandFailed.emit(resolved.enablement.reason);
            return;
        }

        try {
            await this.registry.execute(resolved.command.id, resolved.context);
        } catch (error) {
            this.commandFailed.emit(error instanceof Error ? error.message : 'The command failed.');
        } finally {
            this.closed.emit();
        }
    }

    /** Closes the menu when the backdrop is clicked. */
    dismiss(): void {
        this.closed.emit();
    }
}
