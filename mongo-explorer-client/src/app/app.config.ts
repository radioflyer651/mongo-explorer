import {
    ApplicationConfig,
    provideBrowserGlobalErrorListeners,
    provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeng/themes/aura';
import { routes } from './app.routes';
import { environment } from '../environments/environment';

/**
 * Application providers.
 *
 * Change detection is zoneless: services stay RxJS, and components consume state as
 * signals via toSignal(). There is no zone.js polyfill.
 */
export const appConfig: ApplicationConfig = {
    providers: [
        provideBrowserGlobalErrorListeners(),
        provideZonelessChangeDetection(),
        provideHttpClient(withFetch()),
        provideRouter(routes),
        providePrimeNG({
            /**
             * PrimeNG 22 is licensed, not MIT. Without a valid key it renders a notice
             * in the corner of every page. This project qualifies for the free
             * Community licence — see PRIME-LICENSE.md.
             */
            license: environment.primeUiLicenseKey,
            theme: {
                preset: Aura,
                options: {
                    darkModeSelector: '.dark-mode',
                },
            },
        }),
    ],
};
