import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ObjectId } from 'mongodb';
import { firstValueFrom, takeUntil } from 'rxjs';
import { ComponentBase } from '../../component-base/component-base.component';
import { ConnectionStateService } from '../../../services/connection-state.service';
import {
    AzureOidcFlow,
    ConnectionStrategyKind,
} from '../../../../model/shared-models/connections/connection-strategy-kind.model';
import { SavedConnection, SaveConnectionRequest } from '../../../../model/shared-models/connections/saved-connection.model';

/**
 * Creates a connection.
 *
 * Every strategy gets its own fields. The Entra ID form deliberately surfaces the
 * allowed-hosts list and the token resource as editable values: the driver's default
 * host allow-list excludes Azure hosts, which is the leading suspect for why OIDC
 * fails there, and the correct token resource is not something to guess in code.
 */
@Component({
    selector: 'app-connection-editor',
    imports: [CommonModule, FormsModule],
    templateUrl: './connection-editor.component.html',
    styleUrl: './connection-editor.component.scss',
})
export class ConnectionEditorComponent extends ComponentBase {
    constructor() {
        super();

        effect(() => {
            const id = this.connectionId();

            if (id) {
                this.loadForEditing(id);
            }
        });
    }

    private readonly connections = inject(ConnectionStateService);

    /** Identifier of the connection to edit. Absent when creating a new one. */
    readonly connectionId = input<ObjectId | undefined>(undefined);

    /** Emits when the editor should close. */
    readonly closed = output<void>();

    /** Whether the existing connection is still being fetched. */
    readonly isLoading = signal(false);

    /** Whether a secret is already stored for the connection being edited. */
    readonly hasExistingSecret = signal(false);

    /** The strategy kinds the interface offers. */
    readonly strategies = [
        { kind: ConnectionStrategyKind.ConnectionString, label: 'Connection string' },
        { kind: ConnectionStrategyKind.Scram, label: 'Username and password' },
        { kind: ConnectionStrategyKind.AzureOidc, label: 'Microsoft Entra ID (OIDC)' },
        { kind: ConnectionStrategyKind.X509, label: 'Client certificate (X.509)' },
    ];

    /** The Entra ID sub-flows. */
    readonly oidcFlows = [
        { flow: AzureOidcFlow.AuthorizationCode, label: 'Sign in with a browser (recommended)' },
        { flow: AzureOidcFlow.DeviceCode, label: 'Device code' },
        { flow: AzureOidcFlow.AzureCli, label: 'Existing Azure CLI login' },
        { flow: AzureOidcFlow.ManagedIdentity, label: 'Managed identity' },
        { flow: AzureOidcFlow.ClientCredentials, label: 'Service principal' },
    ];

    /* Shared fields */
    readonly name = signal('');
    readonly strategyKind = signal<ConnectionStrategyKind>(ConnectionStrategyKind.ConnectionString);
    readonly isReadOnly = signal(false);
    readonly notes = signal('');
    readonly secret = signal('');
    readonly rememberSecret = signal(true);

    /* Connection string */
    readonly uri = signal('mongodb://localhost:27017');

    /* SCRAM */
    readonly host = signal('localhost');
    readonly port = signal(27017);
    readonly userName = signal('');
    readonly authSource = signal('admin');

    /* Entra ID */
    readonly oidcHost = signal('');
    /** Blank by default — Azure vCore is SRV-addressed and has no fixed port. */
    readonly oidcPort = signal<number | undefined>(undefined);
    readonly tenantId = signal('');
    readonly clientId = signal('');
    readonly oidcFlow = signal<AzureOidcFlow>(AzureOidcFlow.AuthorizationCode);
    readonly tokenResource = signal('');
    readonly allowedHosts = signal('*.mongocluster.cosmos.azure.com');
    readonly principalName = signal('');

    /* X.509 */
    readonly certificatePath = signal('');

    /** Error text from the last save attempt. */
    readonly saveError = signal<string | undefined>(undefined);

    /** Whether a save is in flight. */
    readonly isSaving = signal(false);

    /** Whether the chosen strategy needs a stored secret. */
    readonly needsSecret = computed(() => {
        switch (this.strategyKind()) {
            case ConnectionStrategyKind.Scram:
                return true;
            case ConnectionStrategyKind.X509:
                return true;
            case ConnectionStrategyKind.AzureOidc:
                return this.oidcFlow() === AzureOidcFlow.ClientCredentials;
            default:
                return false;
        }
    });

    /** Whether the token resource is still unset, which is worth warning about. */
    readonly tokenResourceMissing = computed(
        () => this.strategyKind() === ConnectionStrategyKind.AzureOidc && !this.tokenResource().trim()
    );

    /** Saves the connection. */
    async save(): Promise<void> {
        /* A second click while the first save is in flight would create a duplicate
           connection — the button's disabled class does not prevent the click. */
        if (this.isSaving()) {
            return;
        }

        this.saveError.set(undefined);

        if (!this.name().trim()) {
            this.saveError.set('A connection name is required.');
            return;
        }

        this.isSaving.set(true);

        try {
            await firstValueFrom(this.connections.saveConnection(this.buildRequest()));
            this.closed.emit();
        } catch (error) {
            this.saveError.set(this.describe(error));
        } finally {
            this.isSaving.set(false);
        }
    }

    /** Closes without saving. */
    cancel(): void {
        this.closed.emit();
    }

    /** Fetches an existing connection's full configuration and populates the form. */
    private loadForEditing(connectionId: ObjectId): void {
        this.isLoading.set(true);

        this.connections
            .getConnection(connectionId)
            .pipe(takeUntil(this.ngDestroy$))
            .subscribe({
                next: connection => {
                    this.populateFrom(connection);
                    this.isLoading.set(false);
                },
                error: error => {
                    this.saveError.set(this.describe(error));
                    this.isLoading.set(false);
                },
            });
    }

    /** Fills every signal from a loaded connection, per its strategy. */
    private populateFrom(connection: SavedConnection): void {
        this.name.set(connection.name);
        this.strategyKind.set(connection.strategyKind);
        this.isReadOnly.set(connection.isReadOnly);
        this.notes.set(connection.notes ?? '');
        this.hasExistingSecret.set(false);

        const config = connection.config;

        switch (connection.strategyKind) {
            case ConnectionStrategyKind.ConnectionString:
                this.uri.set(config.connectionString?.uri ?? '');
                break;

            case ConnectionStrategyKind.Scram:
                this.host.set(config.scram?.host ?? '');
                this.port.set(config.scram?.port ?? 27017);
                this.userName.set(config.scram?.userName ?? '');
                this.authSource.set(config.scram?.authSource ?? 'admin');
                this.hasExistingSecret.set(!!config.scram?.hasStoredPassword);
                break;

            case ConnectionStrategyKind.AzureOidc:
                this.oidcHost.set(config.azureOidc?.host ?? '');
                this.oidcPort.set(config.azureOidc?.port);
                this.tenantId.set(config.azureOidc?.tenantId ?? '');
                this.clientId.set(config.azureOidc?.clientId ?? '');
                this.oidcFlow.set(config.azureOidc?.flow ?? AzureOidcFlow.AuthorizationCode);
                this.tokenResource.set(config.azureOidc?.tokenResource ?? '');
                this.allowedHosts.set((config.azureOidc?.allowedHosts ?? []).join(', '));
                this.principalName.set(config.azureOidc?.principalName ?? '');
                this.hasExistingSecret.set(!!config.azureOidc?.hasStoredClientSecret);
                break;

            case ConnectionStrategyKind.X509:
                this.host.set(config.x509?.host ?? '');
                this.port.set(config.x509?.port ?? 27017);
                this.certificatePath.set(config.x509?.certificateKeyFilePath ?? '');
                this.hasExistingSecret.set(!!config.x509?.hasStoredPassphrase);
                break;
        }
    }

    /** Assembles the save request for the chosen strategy. */
    private buildRequest(): SaveConnectionRequest {
        const kind = this.strategyKind();

        const request: SaveConnectionRequest = {
            _id: this.connectionId(),
            name: this.name().trim(),
            strategyKind: kind,
            isReadOnly: this.isReadOnly(),
            notes: this.notes().trim() || undefined,
            config: {},
        };

        if (this.needsSecret() && this.rememberSecret() && this.secret()) {
            request.secret = this.secret();
        }

        /* A secret already stored server-side stays stored even when this save
           doesn't touch it — the secret field is never pre-filled with a real
           value, so "nothing typed" must not read as "no secret exists." */
        const hasStoredSecret = this.hasExistingSecret() || (this.rememberSecret() && !!this.secret());

        switch (kind) {
            case ConnectionStrategyKind.ConnectionString:
                request.config.connectionString = { uri: this.uri().trim() };
                break;

            case ConnectionStrategyKind.Scram:
                request.config.scram = {
                    host: this.host().trim(),
                    port: Number(this.port()),
                    userName: this.userName().trim(),
                    hasStoredPassword: hasStoredSecret,
                    authSource: this.authSource().trim() || undefined,
                };
                break;

            case ConnectionStrategyKind.AzureOidc:
                request.config.azureOidc = {
                    host: this.oidcHost().trim(),
                    port: this.oidcPort() || undefined,
                    tenantId: this.tenantId().trim(),
                    clientId: this.clientId().trim(),
                    flow: this.oidcFlow(),
                    tokenResource: this.tokenResource().trim(),
                    allowedHosts: this.allowedHosts()
                        .split(',')
                        .map(entry => entry.trim())
                        .filter(entry => entry.length > 0),
                    principalName: this.principalName().trim() || undefined,
                    hasStoredClientSecret: hasStoredSecret,
                };
                /* retryWrites: false and maxIdleTimeMs: 120000 are Azure's own
                   documented recommendation for Cosmos DB for MongoDB (vCore) —
                   taken from the connection string the Azure portal generates. */
                request.config.transport = { useTls: true, retryWrites: false, maxIdleTimeMs: 120_000 };
                break;

            case ConnectionStrategyKind.X509:
                request.config.x509 = {
                    host: this.host().trim(),
                    port: Number(this.port()),
                    certificateKeyFilePath: this.certificatePath().trim(),
                    hasStoredPassphrase: hasStoredSecret,
                };
                request.config.transport = { useTls: true };
                break;
        }

        return request;
    }

    /** Extracts a readable message from an HTTP failure. */
    private describe(error: unknown): string {
        if (typeof error === 'object' && error !== null && 'error' in error) {
            const body = (error as { error?: { message?: string; errors?: { path: string; message: string; }[]; }; }).error;

            if (body?.errors?.length) {
                return body.errors.map(entry => `${entry.path}: ${entry.message}`).join('; ');
            }

            if (body?.message) {
                return body.message;
            }
        }

        return error instanceof Error ? error.message : 'The connection could not be saved.';
    }
}
