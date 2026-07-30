import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { TokenPayload } from '../../../../model/shared-models/auth/token-payload.model';
import { environment } from '../../../../environments/environment';
import { TokenService } from '../../token.service';
import { HttpOptionsBuilder } from './api-client-internals';

/** Base for every API client. Holds the transport and the auth plumbing. */
export abstract class ApiClientBase {
    constructor() {
        this.http = inject(HttpClient);
        this.tokenService = inject(TokenService);
        this.optionsBuilder = new HttpOptionsBuilder(this.tokenService);
    }

    /** Angular's HTTP transport. Never used directly from a component. */
    protected readonly http: HttpClient;

    /** Holds the application token. */
    protected readonly tokenService: TokenService;

    /** Builds per-call options, including the auth header. */
    protected readonly optionsBuilder: HttpOptionsBuilder;

    /** Base URL of the Mongo Explorer server. */
    protected readonly baseUrl = environment.apiBaseUrl;

    /** Decodes the held application token. */
    protected parseToken(): TokenPayload | undefined {
        return this.tokenService.parseToken();
    }

    /** Builds a full URL from a path. */
    protected url(path: string): string {
        return `${this.baseUrl}${path}`;
    }

    /** Encodes a path segment that may contain characters needing escaping. */
    protected segment(value: string): string {
        return encodeURIComponent(value);
    }
}
