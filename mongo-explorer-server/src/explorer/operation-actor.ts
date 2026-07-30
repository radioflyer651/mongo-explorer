import { LiveConnection, ReadOnlyConnectionError } from '../connections/live-connection';

/**
 * Who initiated an operation. Threaded to every Target Database write.
 *
 * The actor is a required parameter everywhere — not optional, not defaulted, not
 * inferred — so a new write method that forgets it does not compile.
 */
export type OperationActor = 'user' | 'mcp' | 'system';

/**
 * Refuses a write initiated by anything other than the user.
 *
 * This is the layer that survives a bug in the others. An AI can read a Target
 * Database, drive the interface, and stage a proposal; it cannot write, because the
 * write path itself refuses it below the routes and below the MCP server. There is
 * no flag that relaxes this.
 */
export function assertUserActor(actor: OperationActor, operation: string): void {
    if (actor !== 'user') {
        throw new ForbiddenActorError(
            `Operation '${operation}' requires a user actor; received '${actor}'. ` +
            'AI-originated writes to a Target Database are structurally prohibited. ' +
            'Stage the change as a proposal for the user to execute instead.',
            actor,
            operation
        );
    }
}

/**
 * Combined guard for every Target Database write: the actor must be the user, and
 * the connection must not be marked read-only.
 */
export function assertWriteAllowed(connection: LiveConnection, actor: OperationActor, operation: string): void {
    assertUserActor(actor, operation);

    if (connection.isReadOnly) {
        throw new ReadOnlyConnectionError(connection.connectionName);
    }
}

/** Raised when a non-user actor attempts a Target Database write. */
export class ForbiddenActorError extends Error {
    constructor(message: string, readonly actor: OperationActor, readonly operation: string) {
        super(message);
        this.name = 'ForbiddenActorError';
    }
}
