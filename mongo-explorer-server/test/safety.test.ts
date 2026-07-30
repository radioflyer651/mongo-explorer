import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ForbiddenActorError, assertUserActor, assertWriteAllowed } from '../src/explorer/operation-actor';
import { LiveConnection, ReadOnlyConnectionError } from '../src/connections/live-connection';
import { McpModeService } from '../src/mcp/mcp-mode.service';
import { AppSessionService } from '../src/mcp/app-session.service';
import { ConnectionManager } from '../src/connections/connection-manager.service';
import { SettingsDbService } from '../src/database/settings-db.service';
import { PipelineService } from '../src/explorer/pipeline.service';
import { ShellService } from '../src/explorer/shell.service';
import { SecretCipher } from '../src/utils/secret-cipher';
import { McpMode } from '../src/model/shared-models/mcp/mcp-mode.model';
import { ShellCommandClassification } from '../src/model/shared-models/explorer/shell.model';
import { PipelineStage } from '../src/model/shared-models/explorer/pipeline.model';
import { ILimitsConfig } from '../src/model/app-config.model';
import { redactConnectionString, redactObject, redactText } from '../src/utils/redaction.util';
import { deriveFields, getBsonTypeName, parseExtendedJsonObject, toExtendedJson } from '../src/utils/ejson.util';
import { PROHIBITED_TOOL_NAMES } from '../src/mcp/mcp-server';

/** Limits used throughout these tests. */
const limits: ILimitsConfig = {
    maxPageSize: 100,
    defaultPageSize: 10,
    maxTimeMs: 5_000,
    defaultTimeMs: 1_000,
    schemaSampleSize: 50,
    pipelinePreviewSize: 20,
    maxUndoSnapshotDocuments: 100,
};

/** A settings store that keeps values in memory. */
function fakeSettings(): SettingsDbService {
    const store = new Map<string, unknown>();

    return {
        getSetting: async <T>(key: string, fallback: T) => (store.has(key) ? (store.get(key) as T) : fallback),
        setSetting: async (key: string, value: unknown) => {
            store.set(key, value);
        },
    } as unknown as SettingsDbService;
}

/** A connection stub with only the fields the guards read. */
function fakeConnection(isReadOnly: boolean): LiveConnection {
    return { connectionName: 'test', isReadOnly } as unknown as LiveConnection;
}

/** One pipeline stage. */
function stage(operator: string, body: string, isEnabled = true): PipelineStage {
    return { id: `${operator}-${body}`, operator, body, isEnabled };
}

describe('actor gate', () => {
    it('permits the user', () => {
        assert.doesNotThrow(() => assertUserActor('user', 'updateDocuments'));
    });

    it('refuses an AI actor', () => {
        assert.throws(() => assertUserActor('mcp', 'updateDocuments'), ForbiddenActorError);
    });

    it('refuses a system actor', () => {
        assert.throws(() => assertUserActor('system', 'updateDocuments'), ForbiddenActorError);
    });

    it('explains the proposal route in its message', () => {
        try {
            assertUserActor('mcp', 'deleteDocuments');
            assert.fail('expected a refusal');
        } catch (error) {
            assert.match((error as Error).message, /proposal/i);
            assert.match((error as Error).message, /structurally prohibited/i);
        }
    });

    it('refuses an AI actor even on a writable connection', () => {
        assert.throws(() => assertWriteAllowed(fakeConnection(false), 'mcp', 'dropCollection'), ForbiddenActorError);
    });

    it('refuses the user on a read-only connection', () => {
        assert.throws(() => assertWriteAllowed(fakeConnection(true), 'user', 'dropCollection'), ReadOnlyConnectionError);
    });

    it('permits the user on a writable connection', () => {
        assert.doesNotThrow(() => assertWriteAllowed(fakeConnection(false), 'user', 'dropCollection'));
    });
});

describe('MCP tool surface', () => {
    it('lists apply_proposal as prohibited', () => {
        assert.ok(PROHIBITED_TOOL_NAMES.includes('apply_proposal'));
    });

    it('lists every write-shaped tool name as prohibited', () => {
        for (const name of ['update_documents', 'delete_documents', 'drop_collection', 'drop_database', 'execute_shell']) {
            assert.ok(PROHIBITED_TOOL_NAMES.includes(name), `${name} should be prohibited`);
        }
    });

    it('prohibits an AI from widening its own permissions', () => {
        for (const name of ['set_mcp_mode', 'set_connection_read_only', 'get_connection_credentials']) {
            assert.ok(PROHIBITED_TOOL_NAMES.includes(name), `${name} should be prohibited`);
        }
    });
});

describe('MCP mode gate', () => {
    it('permits everything except data writes in Collaborate', async () => {
        const service = new McpModeService(fakeSettings(), McpMode.Collaborate);

        assert.equal(service.requireRead(), undefined);
        assert.equal(service.requireUiChange(), undefined);
        assert.equal(service.requireProposal(), undefined);
        assert.equal(service.capabilities.canExecuteDataChanges, false);
    });

    it('refuses interface changes in Observe', async () => {
        const service = new McpModeService(fakeSettings(), McpMode.Observe);

        assert.equal(service.requireRead(), undefined);
        assert.equal(service.requireProposal(), undefined);
        assert.equal(service.requireUiChange()?.code, 'mode_blocked');
    });

    it('refuses everything in Off', async () => {
        const service = new McpModeService(fakeSettings(), McpMode.Off);

        assert.equal(service.requireRead()?.code, 'mode_blocked');
        assert.equal(service.requireUiChange()?.code, 'mode_blocked');
        assert.equal(service.requireProposal()?.code, 'mode_blocked');
    });

    it('never permits data writes in any mode', () => {
        for (const mode of [McpMode.Off, McpMode.Observe, McpMode.Collaborate]) {
            const service = new McpModeService(fakeSettings(), mode);
            assert.equal(service.capabilities.canExecuteDataChanges, false, `${mode} must not permit writes`);
        }
    });

    it('narrows Collaborate to Observe when the connection is read-only', async () => {
        const service = new McpModeService(fakeSettings(), McpMode.Collaborate);
        await service.applyReadOnlyNarrowing(true);
        assert.equal(service.currentMode, McpMode.Observe);
    });

    it('persists a mode change', async () => {
        const settings = fakeSettings();
        const first = new McpModeService(settings, McpMode.Collaborate);
        await first.setMode(McpMode.Off, 'test');

        const second = new McpModeService(settings, McpMode.Collaborate);
        await second.initialize();
        assert.equal(second.currentMode, McpMode.Off);
    });
});

describe('dirty-state veto', () => {
    /** A session service with one published dirty region. */
    function sessionWithDirtyEdits(): AppSessionService {
        const service = new AppSessionService(
            new McpModeService(fakeSettings(), McpMode.Collaborate),
            { tryGet: () => undefined } as unknown as ConnectionManager
        );

        service.registerSession();
        service.publish({
            openTabs: [],
            dirtyRegions: [{ surface: 'documentEdits', description: '3 unsaved document edits', itemCount: 3 }],
        });

        return service;
    }

    it('refuses a change that would discard unsaved edits', () => {
        const refusal = sessionWithDirtyEdits().checkDirtyState(['documentEdits'], 'set_query');

        assert.equal(refusal?.code, 'dirty_state_veto');
        assert.match(refusal?.message ?? '', /unsaved/i);
    });

    it('permits a change to an unaffected surface', () => {
        assert.equal(sessionWithDirtyEdits().checkDirtyState(['shellInput'], 'set_shell_input'), undefined);
    });

    it('tells the caller what is unsaved so it can ask rather than guess', () => {
        const refusal = sessionWithDirtyEdits().checkDirtyState(['documentEdits'], 'set_query');
        assert.match(JSON.stringify(refusal?.detail), /3 unsaved document edits/);
        assert.match(refusal?.hint ?? '', /do not retry/i);
    });

    it('refuses a stale revision', () => {
        const service = sessionWithDirtyEdits();
        assert.equal(service.checkRevision(service.revision), undefined);
        assert.equal(service.checkRevision(service.revision - 1)?.code, 'stale_state');
    });

    it('refuses an interface change with no browser session', () => {
        const service = new AppSessionService(
            new McpModeService(fakeSettings(), McpMode.Collaborate),
            { tryGet: () => undefined } as unknown as ConnectionManager
        );

        assert.equal(service.requireActiveSession()?.code, 'no_active_session');
    });
});

describe('pipeline write stages', () => {
    const service = new PipelineService(limits);

    it('detects $out named as the operator', () => {
        assert.deepEqual(service.findWriteStages([stage('$out', '"archive"')]), ['$out']);
    });

    it('detects $merge named as the operator', () => {
        assert.deepEqual(service.findWriteStages([stage('$merge', '{ "into": "archive" }')]), ['$merge']);
    });

    it('detects a write stage carried in the body', () => {
        assert.deepEqual(service.findWriteStages([stage('', '{ "$out": "archive" }')]), ['$out']);
    });

    it('ignores a disabled write stage', () => {
        assert.deepEqual(service.findWriteStages([stage('$out', '"archive"', false)]), []);
    });

    it('reports nothing for a read-only pipeline', () => {
        const pipeline = [stage('$match', '{ "status": "active" }'), stage('$group', '{ "_id": "$kind" }')];
        assert.deepEqual(service.findWriteStages(pipeline), []);
    });

    it('refuses to preview a pipeline containing a write stage', async () => {
        await assert.rejects(
            () =>
                service.previewPipeline({ getDatabase: () => ({}) } as never, {
                    connectionId: undefined as never,
                    databaseName: 'db',
                    collectionName: 'c',
                    stages: [stage('$match', '{}'), stage('$out', '"archive"')],
                    sampleSize: 10,
                }),
            /write stage/i
        );
    });

    it('refuses to explain a pipeline containing a write stage', async () => {
        await assert.rejects(
            () =>
                service.explainPipeline({ getDatabase: () => ({}) } as never, {
                    connectionId: undefined as never,
                    databaseName: 'db',
                    collectionName: 'c',
                    stages: [stage('$merge', '{ "into": "x" }')],
                    sampleSize: 10,
                }),
            /write stage/i
        );
    });
});

describe('shell command classification', () => {
    const service = new ShellService(limits);

    it('accepts a read-only command', () => {
        assert.equal(service.classify('{ "collStats": "orders" }').classification, ShellCommandClassification.ReadOnly);
    });

    it('recognises a write command', () => {
        assert.equal(service.classify('{ "drop": "orders" }').classification, ShellCommandClassification.Write);
    });

    it('refuses an unrecognised command rather than permitting it', () => {
        assert.equal(
            service.classify('{ "someFutureCommand": 1 }').classification,
            ShellCommandClassification.Unclassifiable
        );
    });

    it('refuses unparseable input', () => {
        assert.equal(service.classify('db.orders.find()').classification, ShellCommandClassification.Unclassifiable);
    });

    it('refuses empty input', () => {
        assert.equal(service.classify('   ').classification, ShellCommandClassification.Unclassifiable);
    });

    it('refuses the full mongosh tier outright', async () => {
        await assert.rejects(
            () =>
                service.execute(
                    fakeConnection(false),
                    { connectionId: undefined as never, databaseName: 'db', input: 'db.x.find()', tier: 'mongosh' as never },
                    'user'
                ),
            /not available/i
        );
    });
});

describe('credential redaction', () => {
    it('removes a password from a connection string', () => {
        const redacted = redactConnectionString('mongodb://alice:sup3rs3cret@cluster.example.com:27017/db');

        assert.ok(!redacted.includes('sup3rs3cret'));
        assert.ok(redacted.includes('alice'));
        assert.ok(redacted.includes('cluster.example.com'));
    });

    it('removes a connection string embedded in error text', () => {
        const redacted = redactText('failed: mongodb://bob:hunter2@host:27017 refused');
        assert.ok(!redacted.includes('hunter2'));
    });

    it('removes a JWT from error text', () => {
        const token = 'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
        assert.ok(!redactText(`token ${token} rejected`).includes(token));
    });

    it('removes sensitive properties from a logged object', () => {
        const redacted = redactObject({
            host: 'db.example.com',
            password: 'letmein',
            nested: { accessToken: 'abc123', clientSecret: 'shh' },
        }) as Record<string, unknown>;

        const serialised = JSON.stringify(redacted);

        assert.ok(!serialised.includes('letmein'));
        assert.ok(!serialised.includes('abc123'));
        assert.ok(!serialised.includes('shh'));
        assert.ok(serialised.includes('db.example.com'));
    });

    it('leaves an ordinary message intact so errors stay useful', () => {
        const message = 'Authentication failed against cluster.example.com: bad credentials';
        assert.equal(redactText(message), message);
    });
});

describe('secret encryption at rest', () => {
    it('round-trips a secret', () => {
        const cipher = new SecretCipher('key-material');
        assert.equal(cipher.decrypt(cipher.encrypt('hunter2')), 'hunter2');
    });

    it('produces different ciphertext each time', () => {
        const cipher = new SecretCipher('key-material');
        assert.notEqual(cipher.encrypt('same'), cipher.encrypt('same'));
    });

    it('refuses to decrypt with the wrong key', () => {
        const encrypted = new SecretCipher('key-one').encrypt('hunter2');
        assert.throws(() => new SecretCipher('key-two').decrypt(encrypted));
    });

    it('detects tampering', () => {
        const cipher = new SecretCipher('key-material');
        const encrypted = cipher.encrypt('hunter2');
        const tampered = `${encrypted.slice(0, -4)}AAAA`;

        assert.throws(() => cipher.decrypt(tampered));
    });
});

describe('BSON fidelity', () => {
    it('distinguishes null from absent', () => {
        assert.equal(getBsonTypeName(null), 'null');
        assert.equal(getBsonTypeName(undefined), 'absent');
    });

    it('reports a null field and a missing field as different types', () => {
        const fields = deriveFields([{ a: null }, { b: 1 }]);
        const fieldA = fields.find(field => field.path === 'a');

        assert.deepEqual(fieldA?.types.map(type => type.type), ['null']);
        assert.equal(fieldA?.presentCount, 1);
        assert.equal(fieldA?.sampleSize, 2);
    });

    it('round-trips a date without losing its type', () => {
        const original = { at: new Date('2026-07-29T12:00:00.000Z') };
        const parsed = parseExtendedJsonObject(toExtendedJson(original), 'document');

        assert.ok(parsed['at'] instanceof Date);
        assert.equal((parsed['at'] as Date).toISOString(), '2026-07-29T12:00:00.000Z');
    });

    it('round-trips a null without turning it into undefined', () => {
        const parsed = parseExtendedJsonObject(toExtendedJson({ value: null }), 'document');

        assert.ok('value' in parsed);
        assert.equal(parsed['value'], null);
    });

    it('rejects malformed Extended JSON with a descriptive error', () => {
        assert.throws(() => parseExtendedJsonObject('{ not json', 'filter'), /Could not parse filter/);
    });

    it('rejects an array where an object is required', () => {
        assert.throws(() => parseExtendedJsonObject('[1,2,3]', 'filter'), /Expected filter to be an object/);
    });
});
