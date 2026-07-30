import { Injectable } from '@angular/core';
import { Observable, fromEvent, map, shareReplay, startWith } from 'rxjs';

/** Window dimensions. */
export interface PageDimensions {
    /** Viewport width in pixels. */
    width: number;

    /** Viewport height in pixels. */
    height: number;
}

/** Single source of truth for window-size reactivity. */
@Injectable({ providedIn: 'root' })
export class PageSizeService {
    constructor() {
        this.pageResized$ = fromEvent(window, 'resize').pipe(
            map(() => this.currentDimensions()),
            startWith(this.currentDimensions()),
            shareReplay(1)
        );

        this.isSkinnyPage$ = this.pageResized$.pipe(
            map(dimensions => dimensions.width < 1024),
            shareReplay(1)
        );

        this.pageResized$.subscribe(dimensions => {
            this.latest = dimensions;
        });
    }

    private latest: PageDimensions = { width: window.innerWidth, height: window.innerHeight };

    /** Emits on window resize, starting with the current value. */
    readonly pageResized$: Observable<PageDimensions>;

    /** Emits whether the viewport is narrow. */
    readonly isSkinnyPage$: Observable<boolean>;

    /** True when the viewport is narrower than 1024 pixels. */
    get isSkinnyPage(): boolean {
        return this.latest.width < 1024;
    }

    /** Whether drawers should occupy the full width. */
    get isFullWidthDrawers(): boolean {
        return this.isSkinnyPage;
    }

    /** Whether dialogs should occupy the full screen. */
    get isFullScreenDialogs(): boolean {
        return this.latest.width < 768;
    }

    /** Style object for a standard drawer. */
    get standardDrawerStyle(): Record<string, string> {
        return this.isFullWidthDrawers ? { width: '100vw' } : { width: '640px' };
    }

    /** Style object for a standard dialog. */
    get standardDialogStyle(): Record<string, string> {
        return this.isFullScreenDialogs ? { width: '100vw', height: '100vh' } : { width: '720px' };
    }

    /** Reads the current viewport dimensions. */
    private currentDimensions(): PageDimensions {
        return { width: window.innerWidth, height: window.innerHeight };
    }
}
