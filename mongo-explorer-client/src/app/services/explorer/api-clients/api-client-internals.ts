import { HttpHeaders, HttpParams } from '@angular/common/http';
import { TokenService } from '../../token.service';

/** Options assembled for an HTTP call. */
export interface HttpCallOptions {
    /** Request headers. */
    headers?: HttpHeaders;

    /** Query parameters. */
    params?: HttpParams;
}

/** Fluent builder for one call's options. */
export class OptionsBuilderInternal {
    constructor(private readonly tokenService: TokenService) { }

    private headers = new HttpHeaders();
    private params = new HttpParams();

    /** Attaches the application token. */
    addAuthToken(): OptionsBuilderInternal {
        const token = this.tokenService.token;

        if (token) {
            this.headers = this.headers.set('authorization', token);
        }

        return this;
    }

    /** Adds a query parameter when the value is present. */
    addParam(name: string, value: string | number | boolean | undefined): OptionsBuilderInternal {
        if (value !== undefined && value !== '') {
            this.params = this.params.set(name, String(value));
        }

        return this;
    }

    /** Produces the assembled options. */
    build(): HttpCallOptions {
        return { headers: this.headers, params: this.params };
    }
}

/** Entry point for building call options. */
export class HttpOptionsBuilder {
    constructor(private readonly tokenService: TokenService) { }

    /** Starts a new options chain. */
    buildOptions(): OptionsBuilderInternal {
        return new OptionsBuilderInternal(this.tokenService);
    }

    /** Shortcut for the common case: an authenticated call with no parameters. */
    withAuthorization(): HttpCallOptions {
        return this.buildOptions().addAuthToken().build();
    }
}
