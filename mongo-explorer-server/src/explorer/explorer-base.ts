import { ILimitsConfig } from '../model/app-config.model';
import { clamp } from '../utils/misc.util';

/**
 * Shared limit enforcement for Target Database operations.
 *
 * Every driver call against a Target Database is bounded: an explicit limit, an
 * explicit time budget, and a server-side cap the client cannot raise. There is no
 * unbounded toArray anywhere in this layer.
 */
export abstract class ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        this.limits = limits;
    }

    /** Configured operation limits. */
    protected readonly limits: ILimitsConfig;

    /** Clamps a requested page size into the permitted range. */
    protected resolveLimit(requested: number | undefined): number {
        if (requested === undefined || requested <= 0) {
            return this.limits.defaultPageSize;
        }

        return clamp(Math.floor(requested), 1, this.limits.maxPageSize);
    }

    /** Clamps a requested time budget into the permitted range. */
    protected resolveTimeMs(requested: number | undefined): number {
        if (requested === undefined || requested <= 0) {
            return this.limits.defaultTimeMs;
        }

        return clamp(Math.floor(requested), 100, this.limits.maxTimeMs);
    }

    /** Clamps a requested sample size for previews and schema inference. */
    protected resolveSampleSize(requested: number | undefined, fallback: number): number {
        if (requested === undefined || requested <= 0) {
            return fallback;
        }

        return clamp(Math.floor(requested), 1, this.limits.maxPageSize);
    }

    /** True when a driver error indicates the operation exceeded its time budget. */
    protected isTimeoutError(error: unknown): boolean {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        return message.includes('maxtimems') || message.includes('operation exceeded time limit');
    }
}
