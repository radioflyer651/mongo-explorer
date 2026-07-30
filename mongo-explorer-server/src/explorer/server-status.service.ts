import { injectable } from 'inversify';
import { Document } from 'mongodb';
import { ExplorerServiceBase } from './explorer-base';
import { LiveConnection } from '../connections/live-connection';
import { OperationActor, assertWriteAllowed } from './operation-actor';
import { ILimitsConfig } from '../model/app-config.model';
import { toExtendedJson } from '../utils/ejson.util';
import { errorMessage } from '../utils/misc.util';

/** A summary of deployment health, for the metrics view. */
export interface ServerStatusSummary {
    /** Reported server version. */
    version: string;

    /** Seconds the deployment has been up, when reported. */
    uptimeSeconds?: number;

    /** Current connection counts, when reported. */
    connections?: { current?: number; available?: number; };

    /** Operation counters, when reported. */
    operations?: Record<string, number>;

    /** Full serverStatus reply as Extended JSON, for the raw viewer. */
    rawJson: string;
}

/** One in-progress operation on the deployment. */
export interface CurrentOperation {
    /** Operation identifier, needed to kill it. */
    operationId: string;

    /** Namespace the operation is running against. */
    namespace?: string;

    /** Operation type, for example 'query' or 'command'. */
    operation?: string;

    /** How long it has been running, in seconds. */
    runningTimeSeconds?: number;

    /** The command being executed, as Extended JSON. */
    commandJson?: string;
}

/** Deployment diagnostics and operation administration. */
@injectable()
export class ServerStatusService extends ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        super(limits);
    }

    /** Reads serverStatus and extracts the parts the metrics view needs. */
    async getServerStatus(connection: LiveConnection): Promise<ServerStatusSummary> {
        const status = await connection.runCommand('admin', { serverStatus: 1 });
        const connections = status['connections'] as Document | undefined;
        const counters = status['opcounters'] as Document | undefined;

        const operations: Record<string, number> = {};

        for (const [key, value] of Object.entries(counters ?? {})) {
            if (typeof value === 'number') {
                operations[key] = value;
            }
        }

        return {
            version: String(status['version'] ?? connection.serverCapabilities?.version ?? 'unknown'),
            uptimeSeconds: typeof status['uptime'] === 'number' ? status['uptime'] : undefined,
            connections: connections
                ? {
                    current: typeof connections['current'] === 'number' ? connections['current'] : undefined,
                    available: typeof connections['available'] === 'number' ? connections['available'] : undefined,
                }
                : undefined,
            operations: Object.keys(operations).length ? operations : undefined,
            rawJson: toExtendedJson(status),
        };
    }

    /** Lists in-progress operations. */
    async getCurrentOperations(connection: LiveConnection): Promise<CurrentOperation[]> {
        try {
            const result = await connection.runCommand('admin', { currentOp: 1 });
            const operations = (result['inprog'] as Document[] | undefined) ?? [];

            return operations.map(entry => ({
                operationId: String(entry['opid']),
                namespace: entry['ns'] as string | undefined,
                operation: entry['op'] as string | undefined,
                runningTimeSeconds: typeof entry['secs_running'] === 'number' ? entry['secs_running'] : undefined,
                commandJson: entry['command'] ? toExtendedJson(entry['command']) : undefined,
            }));
        } catch (error) {
            throw new Error(`This deployment refused currentOp: ${errorMessage(error)}`);
        }
    }

    /** Kills an in-progress operation. */
    async killOperation(connection: LiveConnection, operationId: string, actor: OperationActor): Promise<void> {
        assertWriteAllowed(connection, actor, 'killOperation');
        await connection.runCommand('admin', { killOp: 1, op: Number(operationId) });
    }

    /** Lists database users, where the deployment permits it. */
    async listUsers(connection: LiveConnection, databaseName: string): Promise<string> {
        const result = await connection.runCommand(databaseName, { usersInfo: 1 });
        return toExtendedJson(result['users'] ?? []);
    }
}
