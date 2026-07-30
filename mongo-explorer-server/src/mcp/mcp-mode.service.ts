import { injectable } from 'inversify';
import { Observable, Subject } from 'rxjs';
import { SettingsDbService, SETTING_MCP_MODE } from '../database/settings-db.service';
import {
    MCP_MODE_CAPABILITIES,
    McpMode,
    McpModeCapabilities,
    McpRefusal,
} from '../model/shared-models/mcp/mcp-mode.model';

/**
 * Owns the MCP permission mode and enforces it.
 *
 * Enforced server-side, deliberately: a client that fails to render the switch
 * correctly must not be able to widen what an AI can do.
 */
@injectable()
export class McpModeService {
    constructor(settings: SettingsDbService, defaultMode: McpMode) {
        this.settings = settings;
        this.mode = defaultMode;
    }

    private readonly settings: SettingsDbService;
    private mode: McpMode;
    private readonly modeChanges = new Subject<{ mode: McpMode; reason: string; }>();

    /** Emits whenever the mode changes. */
    readonly modeChanged$: Observable<{ mode: McpMode; reason: string; }> = this.modeChanges.asObservable();

    /** Loads the persisted mode, if one has been stored. */
    async initialize(): Promise<void> {
        const stored = await this.settings.getSetting<string | undefined>(SETTING_MCP_MODE, undefined);

        if (stored && Object.values(McpMode).includes(stored as McpMode)) {
            this.mode = stored as McpMode;
        }
    }

    /** The current mode. */
    get currentMode(): McpMode {
        return this.mode;
    }

    /** What the current mode permits. */
    get capabilities(): McpModeCapabilities {
        return MCP_MODE_CAPABILITIES[this.mode];
    }

    /** Changes the mode and persists it. */
    async setMode(mode: McpMode, reason: string): Promise<void> {
        if (this.mode === mode) {
            return;
        }

        this.mode = mode;
        await this.settings.setSetting(SETTING_MCP_MODE, mode);
        this.modeChanges.next({ mode, reason });
    }

    /**
     * Narrows to Observe when the active connection is read-only. If the user has
     * flagged a cluster as hands-off, an AI's interface-driving privileges are the
     * least of what should tighten.
     */
    async applyReadOnlyNarrowing(isActiveConnectionReadOnly: boolean): Promise<void> {
        if (isActiveConnectionReadOnly && this.mode === McpMode.Collaborate) {
            await this.setMode(McpMode.Observe, 'The active connection is marked read-only.');
        }
    }

    /** Refuses when the current mode does not permit reading. */
    requireRead(): McpRefusal | undefined {
        if (this.capabilities.canReadAppState) {
            return undefined;
        }

        return {
            code: 'mode_blocked',
            message: 'The AI mode switch is set to Off, so reading is not permitted.',
            hint: 'Ask the user to set the AI mode switch to Observe or Collaborate in the application toolbar.',
            detail: { currentMode: this.mode, requiredMode: McpMode.Observe },
        };
    }

    /** Refuses when the current mode does not permit changing the interface. */
    requireUiChange(): McpRefusal | undefined {
        if (this.capabilities.canChangeUi) {
            return undefined;
        }

        return {
            code: 'mode_blocked',
            message: `The AI mode switch is set to ${this.mode}, so changing what is on screen is not permitted.`,
            hint:
                'Do not retry. Report to the user that the AI mode switch must be set to Collaborate ' +
                'for this action, and let them decide.',
            detail: { currentMode: this.mode, requiredMode: McpMode.Collaborate },
        };
    }

    /** Refuses when the current mode does not permit staging proposals. */
    requireProposal(): McpRefusal | undefined {
        if (this.capabilities.canStageProposals) {
            return undefined;
        }

        return {
            code: 'mode_blocked',
            message: 'The AI mode switch is set to Off, so proposals cannot be staged.',
            hint: 'Ask the user to set the AI mode switch to Observe or Collaborate.',
            detail: { currentMode: this.mode, requiredMode: McpMode.Observe },
        };
    }
}
