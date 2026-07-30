import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import {
    AppCommand,
    COMMAND_GROUP_ORDER,
    CommandContext,
    ResolvedCommand,
} from './app-command.model';

/**
 * ◈ Command Registry: one declaration per operation, every surface renders from it.
 *
 * Context menus, toolbars, keyboard shortcuts, in-cell buttons, the command palette,
 * and the MCP tool surface are all projections of this registry. Adding a feature
 * means adding a command — that is the first place to look, not a new button
 * somewhere.
 */
@Injectable({ providedIn: 'root' })
export class CommandRegistry {
    private readonly commands = new Map<string, AppCommand>();
    private readonly _changed = new BehaviorSubject<number>(0);

    /** Emits whenever the registered set changes. */
    readonly changed$: Observable<number> = this._changed.asObservable();

    /** Registers a command. Later registrations of the same id replace earlier ones. */
    register(command: AppCommand): void {
        this.commands.set(command.id, command);
        this._changed.next(this._changed.value + 1);
    }

    /** Registers several commands at once. */
    registerAll(commands: readonly AppCommand[]): void {
        commands.forEach(command => this.commands.set(command.id, command));
        this._changed.next(this._changed.value + 1);
    }

    /** Looks up one command. */
    get(commandId: string): AppCommand | undefined {
        return this.commands.get(commandId);
    }

    /** Every registered command. */
    get all(): AppCommand[] {
        return [...this.commands.values()];
    }

    /**
     * Resolves the commands that apply to a context, in display order.
     *
     * Visible-but-disabled beats hidden: isVisible is for commands that are genuinely
     * inapplicable, not for ones merely unavailable right now. Hiding a command
     * teaches the user it does not exist.
     */
    commandsFor(context: CommandContext): ResolvedCommand[] {
        const applicable = this.all
            .filter(command => command.appliesTo.includes(context.kind))
            .filter(command => this.safeIsVisible(command, context));

        const resolved = applicable.map(command => ({
            command,
            context,
            enablement: this.safeIsEnabled(command, context),
        }));

        return resolved.sort((first, second) => {
            const groupDifference =
                COMMAND_GROUP_ORDER.indexOf(first.command.group) - COMMAND_GROUP_ORDER.indexOf(second.command.group);

            return groupDifference !== 0 ? groupDifference : first.command.order - second.command.order;
        });
    }

    /** Finds the command bound to a keyboard shortcut. */
    commandForKeybinding(keybinding: string): AppCommand | undefined {
        return this.all.find(command => command.keybinding === keybinding);
    }

    /** Invokes a command by id against a context. */
    async execute(commandId: string, context: CommandContext): Promise<void> {
        const command = this.commands.get(commandId);

        if (!command) {
            throw new Error(`No command is registered with id '${commandId}'.`);
        }

        if (!command.appliesTo.includes(context.kind)) {
            throw new Error(`Command '${commandId}' does not apply to a ${context.kind} context.`);
        }

        const enablement = this.safeIsEnabled(command, context);

        if (!enablement.enabled) {
            throw new Error(enablement.reason);
        }

        await command.execute(context);
    }

    /** A faulty predicate hides the command rather than breaking the whole menu. */
    private safeIsVisible(command: AppCommand, context: CommandContext): boolean {
        try {
            return command.isVisible(context);
        } catch {
            return false;
        }
    }

    /** A faulty predicate disables the command rather than breaking the menu. */
    private safeIsEnabled(command: AppCommand, context: CommandContext): ResolvedCommand['enablement'] {
        try {
            return command.isEnabled(context);
        } catch (error) {
            return {
                enabled: false,
                reason: error instanceof Error ? error.message : 'This command reported an error.',
            };
        }
    }
}
