import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { TokenPayload } from '../../model/shared-models/auth/token-payload.model';

/** Key under which the application token is stored. */
const TOKEN_STORAGE_KEY = 'mongo-explorer.token';

/**
 * Holds the application token. This is application authentication — who is using
 * Mongo Explorer — and has nothing to do with Target Database credentials, which
 * never reach the browser.
 */
@Injectable({ providedIn: 'root' })
export class TokenService {
    constructor() {
        const stored = localStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined;
        this._token = new BehaviorSubject<string | undefined>(stored);
    }

    private readonly _token: BehaviorSubject<string | undefined>;

    /** Emits the current token, or undefined when there is none. */
    get token$(): Observable<string | undefined> {
        return this._token.asObservable();
    }

    /** The current token, or undefined. */
    get token(): string | undefined {
        return this._token.value;
    }

    /** Whether a token is held. */
    get hasToken(): boolean {
        return this._token.value !== undefined;
    }

    /** Stores a token. */
    setToken(token: string): void {
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
        this._token.next(token);
    }

    /** Clears the token. */
    clearToken(): void {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        this._token.next(undefined);
    }

    /** Decodes the held token, or returns undefined when there is none. */
    parseToken(): TokenPayload | undefined {
        const token = this._token.value;

        if (!token) {
            return undefined;
        }

        try {
            return JSON.parse(atob(token.split('.')[1])) as TokenPayload;
        } catch {
            return undefined;
        }
    }
}
