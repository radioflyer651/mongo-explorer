import { BsonTypeName } from '../../../model/shared-models/explorer/bson-type.model';
import { ConnectionState } from '../../../model/shared-models/connections/connection-state.model';
import { McpClassification } from '../../../model/shared-models/mcp/mcp-mode.model';

/**
 * Grouping key. Renderers insert separators between groups, so ordering is
 * consistent everywhere a command appears.
 */
export enum CommandGroup {
    Open = 'open',
    Create = 'create',
    Edit = 'edit',
    Clipboard = 'clipboard',
    Query = 'query',
    Transfer = 'transfer',
    Admin = 'admin',
    Connection = 'connection',

    /** Always last, always visually separated. */
    Destructive = 'destructive',
}

/** Fixed display order for the groups. */
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
    CommandGroup.Open,
    CommandGroup.Create,
    CommandGroup.Edit,
    CommandGroup.Clipboard,
    CommandGroup.Query,
    CommandGroup.Transfer,
    CommandGroup.Admin,
    CommandGroup.Connection,
    CommandGroup.Destructive,
];

/** What a command is acting on. A discriminated union, so renderers agree. */
export type CommandContext =
    | { readonly kind: 'app'; }
    | { readonly kind: 'connection'; readonly connectionId: string; readonly connectionName: string; readonly state: ConnectionState; readonly isReadOnly: boolean; }
    | { readonly kind: 'database'; readonly connectionId: string; readonly databaseName: string; readonly isReadOnly: boolean; }
    | { readonly kind: 'collection'; readonly connectionId: string; readonly databaseName: string; readonly collectionName: string; readonly isReadOnly: boolean; }
    | { readonly kind: 'document'; readonly connectionId: string; readonly databaseName: string; readonly collectionName: string; readonly isReadOnly: boolean; readonly documentIds: readonly unknown[]; }
    | { readonly kind: 'field'; readonly path: string; readonly value: unknown; readonly bsonType: BsonTypeName; readonly isReadOnly: boolean; }
    | { readonly kind: 'index'; readonly connectionId: string; readonly databaseName: string; readonly collectionName: string; readonly indexName: string; readonly isReadOnly: boolean; }
    | { readonly kind: 'pipelineStage'; readonly stageIndex: number; readonly operator: string; readonly isEnabled: boolean; }
    | { readonly kind: 'shellEntry'; readonly entryId: string; }
    | { readonly kind: 'proposal'; readonly proposalId: string; readonly isPending: boolean; };

/** Every context discriminator. */
export type CommandContextKind = CommandContext['kind'];

/**
 * Whether a command can be invoked, and if not, why not.
 *
 * The reason is mandatory and user-facing. A disabled control with no explanation is
 * the most common way a capable tool comes to feel broken.
 */
export type CommandEnablement =
    | { readonly enabled: true; }
    | { readonly enabled: false; readonly reason: string; };

/** Convenience: an enabled result. */
export const ENABLED: CommandEnablement = { enabled: true };

/** Convenience: a disabled result carrying its reason. */
export function disabled(reason: string): CommandEnablement {
    return { enabled: false, reason };
}

/**
 * A single user-invocable operation, rendered identically wherever it appears.
 *
 * Context menus, toolbars, keyboard shortcuts, in-cell buttons, the command palette,
 * and the MCP tool surface are all projections of these declarations. Renderers
 * contain no behaviour: if a renderer needs a special case, the declaration is wrong.
 */
export interface AppCommand<TContext extends CommandContext = CommandContext> {
    /** Stable dotted identifier, for example 'collection.drop'. Never displayed. */
    readonly id: string;

    /** Menu and tooltip text. Sentence case. */
    readonly label: string;

    /** Icon class from the canonical icon map. */
    readonly icon: string;

    /** Which context kinds this command applies to. */
    readonly appliesTo: readonly CommandContextKind[];

    /** Grouping key. */
    readonly group: CommandGroup;

    /** Sort order within the group. */
    readonly order: number;

    /** Optional keyboard shortcut, for example 'ctrl+enter'. */
    readonly keybinding?: string;

    /** True for operations that destroy or overwrite data. */
    readonly isDestructive?: boolean;

    /**
     * How this command is exposed over MCP. Anything that writes must be 'never' or
     * 'propose'.
     */
    readonly mcp?: McpClassification;

    /** Whether the command appears at all for this context. */
    isVisible(context: TContext): boolean;

    /** Whether it can be invoked, and if not, why not. */
    isEnabled(context: TContext): CommandEnablement;

    /** Performs the operation. Renderers never implement behaviour. */
    execute(context: TContext): Promise<void> | void;
}

/** A command paired with the context it will act on. */
export interface ResolvedCommand {
    /** The declaration. */
    readonly command: AppCommand;

    /** The context it applies to. */
    readonly context: CommandContext;

    /** Whether it can be invoked right now. */
    readonly enablement: CommandEnablement;
}
