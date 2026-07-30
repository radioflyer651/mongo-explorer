/** Production environment. */
export const environment = {
    /** Whether this is a development build. */
    isDevelopment: false,

    /** Base URL of the Mongo Explorer server. */
    apiBaseUrl: 'http://127.0.0.1:27050',

    /** Socket.IO endpoint. */
    socketUrl: 'http://127.0.0.1:27050',

    /**
     * PrimeUI (PrimeNG) licence key. Empty until one is issued, which is why the
     * "Invalid PrimeUI License" banner appears.
     *
     * See [PRIME-LICENSE.md](../../PRIME-LICENSE.md) for how to obtain the free
     * Community key and where to paste it.
     */
    primeUiLicenseKey: '',
};
