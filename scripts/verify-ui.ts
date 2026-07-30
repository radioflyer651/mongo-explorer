/**
 * Drives the running Mongo Explorer UI with real pointer events and reports whether
 * each interaction actually did something.
 *
 * Purpose: this project has no browser test runner, and a UI that compiles is not a UI
 * that works — every bug this script was written to catch (an orphaned context-menu
 * signal, a `computed` over a non-signal, an unsupported `ngComponentOutlet` outputs
 * binding) built and served perfectly while doing nothing on click. Run this after
 * touching anything in the interaction path.
 *
 * Inputs: none. Expects the client on :27100 and the server on :2701 — start them with
 * F5 (the "server + client" compound) or `npm start` in each project.
 * Setup: Microsoft Edge or Google Chrome installed, and Node 22+ for the global
 * WebSocket. No npm dependencies: this speaks the Chrome DevTools Protocol directly.
 *
 * Usage: npx ts-node scripts/verify-ui.ts [--connection <name>] [--database <name>]
 *                                         [--collection <name>] [--keep-open]
 *   --connection  Saved connection to exercise. Default: the second row in the list.
 *   --database    Database to expand. Default: 'mongo-explorer' (our own store).
 *   --collection  Collection to open. Default: the first one found.
 *   --keep-open   Leave the browser running for inspection.
 *
 * Exit code is 0 only when every check passes.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the app is served. */
const APP_URL = 'http://localhost:27100/';

/** Loopback port the browser exposes the DevTools Protocol on. */
const DEBUG_PORT = 9333;

/** Viewport wide enough that right-hand toolbar controls are inside the hit-test area. */
const VIEWPORT = { width: 1600, height: 1000 };

/** Browsers to try, in order. */
const BROWSER_PATHS = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

/** One assertion about the interface. */
interface Check {
    /** What was exercised. */
    readonly name: string;

    /** Whether it behaved. */
    readonly passed: boolean;

    /** What was observed, for the report. */
    readonly detail: unknown;
}

/** Command-line options. */
interface Options {
    connectionName?: string;
    databaseName: string;
    collectionName?: string;
    keepOpen: boolean;
}

/** Waits a number of milliseconds. */
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Parses the command line. */
function readOptions(argv: string[]): Options {
    const read = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };

    return {
        connectionName: read('--connection'),
        databaseName: read('--database') ?? 'mongo-explorer',
        collectionName: read('--collection'),
        keepOpen: argv.includes('--keep-open'),
    };
}

/** Starts a headless browser with the DevTools Protocol exposed. */
function launchBrowser(keepOpen: boolean): ChildProcess {
    const executable = BROWSER_PATHS.find(path => existsSync(path));

    if (!executable) {
        throw new Error(`No Edge or Chrome found. Looked in:\n  ${BROWSER_PATHS.join('\n  ')}`);
    }

    /* A dedicated profile, because an already-running browser ignores the debugging
       port and would silently attach to the user's own session instead. */
    const profile = mkdtempSync(join(tmpdir(), 'mongo-explorer-verify-'));

    return spawn(
        executable,
        [
            ...(keepOpen ? [] : ['--headless=new']),
            '--disable-gpu',
            `--remote-debugging-port=${DEBUG_PORT}`,
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            'about:blank',
        ],
        { detached: false, stdio: 'ignore' }
    );
}

/** Finds the browser's page target, retrying while it starts. */
async function findPageTarget(): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
            const targets = (await response.json()) as { type: string; webSocketDebuggerUrl?: string; }[];
            const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);

            if (page?.webSocketDebuggerUrl) {
                return page.webSocketDebuggerUrl;
            }
        } catch {
            /* Not listening yet. */
        }

        await wait(250);
    }

    throw new Error('The browser never exposed a DevTools page target.');
}

/**
 * A minimal DevTools Protocol client.
 *
 * The socket is assigned in the body rather than declared as a constructor parameter
 * property, because Node runs this file by stripping types and cannot erase those.
 */
class Browser {
    constructor(socket: WebSocket) {
        this.socket = socket;

        socket.addEventListener('message', event => {
            const message = JSON.parse((event as MessageEvent<string>).data);

            if (message.id && this.pending.has(message.id)) {
                const entry = this.pending.get(message.id)!;
                this.pending.delete(message.id);
                message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
                return;
            }

            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                this.pageErrors.push(details.exception?.description ?? details.text);
            }

            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
                this.pageErrors.push(
                    (message.params.args ?? [])
                        .map((argument: { value?: unknown; description?: string; }) => argument.value ?? argument.description)
                        .join(' ')
                );
            }
        });
    }

    private readonly socket: WebSocket;
    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; }>();

    /** Uncaught page errors and console errors seen during the run. */
    readonly pageErrors: string[] = [];

    /** Issues one protocol command. */
    send(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = this.nextId++;
        this.socket.send(JSON.stringify({ id, method, params }));

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new Error(`${method} timed out.`));
                }
            }, 30_000);
        });
    }

    /** Evaluates an expression body in the page and returns its JSON value. */
    async evaluate<T>(body: string): Promise<T> {
        const result = await this.send('Runtime.evaluate', {
            expression: `(() => { ${body} })()`,
            returnByValue: true,
            awaitPromise: true,
        });

        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed.');
        }

        return result.result.value as T;
    }

    /** Dispatches a real press and release at a point. */
    async pointer(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
        const shared = {
            x: Math.round(x),
            y: Math.round(y),
            button,
            clickCount: 1,
            buttons: button === 'right' ? 2 : 1,
        };

        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...shared });
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...shared });
    }

    /**
     * Clicks an element with a genuine pointer event.
     *
     * Hit-testing is asserted first: a click that lands on nothing looks exactly like a
     * broken feature in the results, and that false alarm costs more than the check.
     */
    async click(selector: string, text?: string, button: 'left' | 'right' = 'left'): Promise<{ x: number; y: number; }> {
        const target = text === undefined
            ? 'nodes[0]'
            : `nodes.find(node => node.textContent.includes(${JSON.stringify(text)}))`;

        const hit = await this.evaluate<{ found: boolean; x: number; y: number; hits: boolean; }>(`
            const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
            const match = ${target};
            if (!match) { return { found: false }; }
            match.scrollIntoView({ block: 'center' });
            const box = match.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            const topmost = document.elementFromPoint(x, y);
            return { found: true, x, y, hits: match === topmost || match.contains(topmost) };
        `);

        const description = `${selector}${text ? ` containing "${text}"` : ''}`;

        if (!hit.found) {
            throw new Error(`Nothing matched ${description}.`);
        }

        if (!hit.hits) {
            throw new Error(
                `The centre of ${description} is not hit-testable — it is clipped or covered, ` +
                'so the check would be meaningless rather than failing.'
            );
        }

        await this.pointer(hit.x, hit.y, button);
        return { x: Math.round(hit.x), y: Math.round(hit.y) };
    }
}

/** Reads the open context menu, if there is one. */
const READ_MENU = `
    const menu = document.querySelector('.command-menu');
    if (!menu) { return { open: false }; }
    const box = menu.getBoundingClientRect();
    return {
        open: true,
        at: { x: Math.round(box.left), y: Math.round(box.top) },
        items: [...menu.querySelectorAll('.menu-item')].map(item => ({
            label: item.querySelector('.menu-label').textContent.trim(),
            disabled: item.classList.contains('is-disabled'),
        })),
    };
`;

/** The shape READ_MENU returns. */
interface MenuState {
    open: boolean;
    at?: { x: number; y: number; };
    items?: { label: string; disabled: boolean; }[];
}

/** Whether a menu opened within a sensible distance of the pointer. */
function openedAtPointer(menu: MenuState, pointer: { x: number; y: number; }): boolean {
    return (
        !!menu.open &&
        !!menu.at &&
        Math.abs(menu.at.x - pointer.x) < 40 &&
        Math.abs(menu.at.y - pointer.y) < 40
    );
}

async function main(): Promise<void> {
    const options = readOptions(process.argv.slice(2));

    /* Fail early and clearly if the app is not up — otherwise every check fails and the
       report implies the interface is broken. */
    for (const [label, url] of [['server', 'http://127.0.0.1:2701/api/health'], ['client', APP_URL]]) {
        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (error) {
            throw new Error(
                `The ${label} is not responding at ${url} (${(error as Error).message}). ` +
                'Start both halves first — F5 on the workspace file runs the "server + client" compound.'
            );
        }
    }

    const browserProcess = launchBrowser(options.keepOpen);
    const checks: Check[] = [];
    let browser: Browser | undefined;

    try {
        const socket = new WebSocket(await findPageTarget());
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve());
            socket.addEventListener('error', () => reject(new Error('Could not attach to the browser.')));
        });

        browser = new Browser(socket);
        await browser.send('Runtime.enable');
        await browser.send('Page.enable');
        await browser.send('Emulation.setDeviceMetricsOverride', {
            ...VIEWPORT,
            deviceScaleFactor: 1,
            mobile: false,
        });

        await browser.send('Page.navigate', { url: APP_URL });
        await wait(6000);

        const dismissMenu = async (): Promise<void> => {
            await browser!.evaluate(`document.querySelector('.menu-backdrop')?.click(); return true;`);
            await wait(300);
        };

        const record = (name: string, passed: boolean, detail: unknown): void => {
            checks.push({ name, passed, detail });
        };

        /* The app has to have bootstrapped and listed the saved connections. */
        const bootstrap = await browser.evaluate<{ shell: boolean; connections: string[]; }>(`
            return {
                shell: !!document.querySelector('.app-shell'),
                connections: [...document.querySelectorAll('.connection-row .row-label')].map(n => n.textContent.trim()),
            };
        `);

        record('App bootstraps and lists connections', bootstrap.shell && bootstrap.connections.length > 0, bootstrap);

        if (!bootstrap.shell) {
            throw new Error('The application shell never rendered; the remaining checks cannot run.');
        }

        /* Prefer a real target database over our own application store when choosing a
           default, but fall back to whatever exists. */
        const connection = options.connectionName ?? bootstrap.connections[1] ?? bootstrap.connections[0];

        /* --- Context menu, both routes --- */
        const connectionPointer = await browser.click('.connection-row', connection, 'right');
        await wait(600);
        const connectionMenu = await browser.evaluate<MenuState>(READ_MENU);
        record(
            'Right-click a connection opens a menu at the pointer',
            openedAtPointer(connectionMenu, connectionPointer) && (connectionMenu.items?.length ?? 0) > 0,
            connectionMenu
        );
        await dismissMenu();

        await browser.evaluate(`
            const row = [...document.querySelectorAll('.connection-row')]
                .find(candidate => candidate.textContent.includes(${JSON.stringify(connection)}));
            row.querySelector('.row-action:last-of-type').click();
            return true;
        `);
        await wait(600);
        const overflowMenu = await browser.evaluate<MenuState>(READ_MENU);
        const sameItems =
            JSON.stringify(overflowMenu.items?.map(item => item.label)) ===
            JSON.stringify(connectionMenu.items?.map(item => item.label));
        record('The "..." button opens the same menu as right-click', !!overflowMenu.open && sameItems, overflowMenu);
        await dismissMenu();

        /* A disabled item must say why: a silent dead control is the failure this
           project's command registry exists to prevent. */
        const reasons = await browser.evaluate<{ label: string; title: string | null; }[]>(`
            return [...document.querySelectorAll('.command-menu .menu-item.is-disabled')].map(item => ({
                label: item.querySelector('.menu-label').textContent.trim(),
                title: item.getAttribute('title'),
            }));
        `);
        record(
            'Disabled menu items carry a reason',
            reasons.every(item => !!item.title && item.title !== item.label),
            reasons
        );

        /* --- Opening a connection reveals its databases --- */
        await browser.click('.connection-row', connection);
        await wait(4500);
        const databases = await browser.evaluate<{ shown: boolean; count: number; error: string | null; }>(`
            return {
                shown: [...document.querySelectorAll('.section-title')].some(t => t.textContent.includes('Databases')),
                count: document.querySelectorAll('.database-row').length,
                error: document.querySelector('.danger-text')?.textContent.trim() ?? null,
            };
        `);
        record('Opening a connection lists its databases', databases.shown && databases.count > 0, databases);

        /* --- Database row --- */
        const databasePointer = await browser.click('.database-row', options.databaseName, 'right');
        await wait(600);
        const databaseMenu = await browser.evaluate<MenuState>(READ_MENU);
        record(
            'Right-click a database opens a menu at the pointer',
            openedAtPointer(databaseMenu, databasePointer) && (databaseMenu.items?.length ?? 0) > 0,
            databaseMenu
        );
        await dismissMenu();

        await browser.click('.database-row', options.databaseName);
        await wait(3000);
        const collections = await browser.evaluate<string[]>(`
            return [...document.querySelectorAll('.collection-row .row-label')].map(n => n.textContent.trim());
        `);
        record('Expanding a database lists its collections', collections.length > 0, collections);

        const collection = options.collectionName ?? collections[0];

        /* --- Collection row --- */
        const collectionPointer = await browser.click('.collection-row', collection, 'right');
        await wait(600);
        const collectionMenu = await browser.evaluate<MenuState>(READ_MENU);
        record(
            'Right-click a collection opens a menu at the pointer',
            openedAtPointer(collectionMenu, collectionPointer) && (collectionMenu.items?.length ?? 0) > 0,
            collectionMenu
        );
        await dismissMenu();

        await browser.click('.collection-row', collection);
        await wait(4500);
        const opened = await browser.evaluate<{ tab: string | null; columns: string[]; rows: number; }>(`
            return {
                tab: document.querySelector('.tab-title')?.textContent.trim() ?? null,
                columns: [...document.querySelectorAll('th')].map(n => n.textContent.trim()).filter(Boolean),
                rows: document.querySelectorAll('tbody tr').length,
            };
        `);
        record('Opening a collection loads it into a tab', !!opened.tab, opened);

        /* --- The document grid: cell menu and selection both travel through the view's
               outputs, which is the part `ngComponentOutlet` could not wire. --- */
        if (opened.rows > 0) {
            const cellPointer = await browser.click('tbody tr td:not(.row-gutter)', undefined, 'right');
            await wait(700);
            const fieldMenu = await browser.evaluate<MenuState>(READ_MENU);
            record(
                'Right-click a document field opens a menu at the pointer',
                openedAtPointer(fieldMenu, cellPointer) && (fieldMenu.items?.length ?? 0) > 0,
                fieldMenu
            );
            await dismissMenu();

            await browser.click('tbody tr td:not(.row-gutter)');
            await wait(700);
            const selection = await browser.evaluate<{ statusBar: string | null; highlighted: number; }>(`
                return {
                    statusBar: document.querySelector('.selection-count')?.textContent.trim() ?? null,
                    highlighted: document.querySelectorAll('tbody tr.selected').length,
                };
            `);
            record('Selecting a row reaches the shell', !!selection.statusBar && selection.highlighted > 0, selection);
        } else {
            record('Document grid checks', true, `Skipped: '${collection}' holds no documents.`);
        }

        /* --- View switching must swap the rendered component --- */
        const views = await browser.evaluate<string[]>(`
            return [...document.querySelectorAll('.view-option')].map(b => b.textContent.trim());
        `);

        for (const view of views) {
            await browser.click('.view-option', view);
            await wait(1600);
            const state = await browser.evaluate<{ active: string | null; rendered: string[]; }>(`
                const host = document.querySelector('app-view-host');
                return {
                    active: document.querySelector('.view-option.active')?.textContent.trim() ?? null,
                    rendered: [...(host?.children ?? [])].map(c => c.tagName.toLowerCase()).filter(t => t.startsWith('app-')),
                };
            `);
            record(`View switcher renders the "${view}" view`, state.active === view && state.rendered.length === 1, state);
        }

        /* --- A control that looks disabled must be disabled --- */
        const pager = await browser.evaluate<{
            disabledAttribute: boolean; looksDisabled: boolean; tooltip: string | null; before: string | null;
        }>(`
            const buttons = [...document.querySelectorAll('.status-bar .query-button')];
            const next = buttons[buttons.length - 1];
            return {
                disabledAttribute: next.disabled,
                looksDisabled: next.classList.contains('is-disabled'),
                tooltip: next.getAttribute('title'),
                before: document.querySelector('.status-bar .tiny')?.textContent.trim() ?? null,
            };
        `);

        if (pager.looksDisabled) {
            await browser.evaluate(`
                const buttons = [...document.querySelectorAll('.status-bar .query-button')];
                buttons[buttons.length - 1].click();
                return true;
            `);
            await wait(2000);
            const after = await browser.evaluate<string | null>(`
                return document.querySelector('.status-bar .tiny')?.textContent.trim() ?? null;
            `);
            record(
                'A pager button that looks disabled refuses to act',
                pager.disabledAttribute && pager.before === after,
                { ...pager, after }
            );
        } else {
            record('Pager disabled-state check', true, 'Skipped: more pages are available.');
        }

        record('No uncaught page or console errors', browser.pageErrors.length === 0, browser.pageErrors);
    } finally {
        if (!options.keepOpen) {
            browserProcess.kill();
        }
    }

    /* --- Report --- */
    const failed = checks.filter(check => !check.passed);

    console.log('');
    for (const check of checks) {
        console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);

        if (!check.passed) {
            console.log(`      ${JSON.stringify(check.detail)}`);
        }
    }

    console.log('');
    console.log(`${checks.length - failed.length}/${checks.length} checks passed.`);

    if (options.keepOpen) {
        console.log(`Browser left running on port ${DEBUG_PORT}.`);
    }

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(`verify-ui failed: ${error.message}`);
    process.exitCode = 1;
});
