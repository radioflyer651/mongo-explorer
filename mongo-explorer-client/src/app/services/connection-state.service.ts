import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, Subject, map, of, shareReplay, startWith, switchMap } from 'rxjs';
import { ObjectId } from 'mongodb';
import { ClientApiService } from './explorer/api-clients/client-api.service';
import {
    ConnectionState,
    ConnectionStatus,
} from '../../model/shared-models/connections/connection-state.model';
import {
    SaveConnectionRequest,
    SavedConnectionListing,
} from '../../model/shared-models/connections/saved-connection.model';

/** Holds saved connections and the live status of each. */
@Injectable({ providedIn: 'root' })
export class ConnectionStateService {
    constructor() {
        this.initialize();
    }

    private readonly api = inject(ClientApiService);
    private readonly _reloadConnections = new Subject<void>();
    private readonly _statuses = new BehaviorSubject<Map<string, ConnectionStatus>>(new Map());
    private readonly _activeConnectionId = new BehaviorSubject<ObjectId | undefined>(undefined);

    /** Saved connections, reloaded on demand. */
    connectionListing$!: Observable<SavedConnectionListing[]>;

    /** Live status of every connection, keyed by identifier. */
    readonly statuses$: Observable<Map<string, ConnectionStatus>> = this._statuses.asObservable();

    /** The connection currently in use. */
    readonly activeConnectionId$: Observable<ObjectId | undefined> = this._activeConnectionId.asObservable();

    /** Wires the reload stream. */
    private initialize(): void {
        this.connectionListing$ = this._reloadConnections.pipe(
            startWith(undefined),
            switchMap(() => this.api.getConnections()),
            shareReplay(1)
        );

        this.api.getConnectionStatuses().subscribe(statuses => {
            statuses.forEach(status => this.applyStatus(status));
        });
    }

    /** Triggers a reload of the connection list. */
    reloadConnections(): void {
        this._reloadConnections.next();
    }

    /** The identifier of the connection in use. */
    get activeConnectionId(): ObjectId | undefined {
        return this._activeConnectionId.value;
    }

    /** Sets the connection in use. */
    setActiveConnection(connectionId: ObjectId | undefined): void {
        this._activeConnectionId.next(connectionId);
    }

    /** The current status of one connection. */
    statusFor(connectionId: ObjectId): ConnectionStatus | undefined {
        return this._statuses.value.get(connectionId);
    }

    /** Emits the status of one connection. */
    statusFor$(connectionId: ObjectId): Observable<ConnectionStatus | undefined> {
        return this.statuses$.pipe(map(statuses => statuses.get(connectionId)));
    }

    /** Whether a connection is connected and usable. */
    isUsable(connectionId: ObjectId): boolean {
        const state = this.statusFor(connectionId)?.state;
        return state === ConnectionState.Connected || state === ConnectionState.CredentialExpiring;
    }

    /** Records a status pushed from the server. */
    applyStatus(status: ConnectionStatus): void {
        const next = new Map(this._statuses.value);
        next.set(String(status.connectionId), status);
        this._statuses.next(next);
    }

    /** Creates or updates a connection, then reloads the list. */
    saveConnection(request: SaveConnectionRequest): Observable<SavedConnectionListing> {
        return this.api.saveConnection(request).pipe(
            switchMap(result => {
                this.reloadConnections();
                return of(result);
            })
        );
    }

    /** Deletes a connection, then reloads the list. */
    deleteConnection(connectionId: ObjectId): Observable<{ deleted: boolean; }> {
        return this.api.deleteConnection(connectionId).pipe(
            switchMap(result => {
                this.reloadConnections();

                if (this._activeConnectionId.value === connectionId) {
                    this._activeConnectionId.next(undefined);
                }

                return of(result);
            })
        );
    }

    /** Opens a connection and records the resulting status. */
    connect(connectionId: ObjectId): Observable<ConnectionStatus> {
        return this.api.connect(connectionId).pipe(
            switchMap(status => {
                this.applyStatus(status);
                this.setActiveConnection(connectionId);
                this.reloadConnections();
                return of(status);
            })
        );
    }

    /** Closes a connection. */
    disconnect(connectionId: ObjectId): Observable<{ disconnected: boolean; }> {
        return this.api.disconnect(connectionId).pipe(
            switchMap(result => {
                const next = new Map(this._statuses.value);
                next.delete(connectionId);
                this._statuses.next(next);

                if (this._activeConnectionId.value === connectionId) {
                    this._activeConnectionId.next(undefined);
                }

                return of(result);
            })
        );
    }

    /** Sets the read-only guard rail, then reloads the list. */
    setReadOnly(connectionId: ObjectId, isReadOnly: boolean): Observable<{ isReadOnly: boolean; }> {
        return this.api.setConnectionReadOnly(connectionId, isReadOnly).pipe(
            switchMap(result => {
                this.reloadConnections();
                return of(result);
            })
        );
    }
}
