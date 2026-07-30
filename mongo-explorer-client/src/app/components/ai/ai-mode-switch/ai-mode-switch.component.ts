import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { AiSessionService } from '../../../services/ai-session.service';
import { ComponentBase } from '../../component-base/component-base.component';
import { ICONS } from '../../../core/icons';
import { MCP_MODE_CAPABILITIES, McpMode } from '../../../../model/shared-models/mcp/mcp-mode.model';

/** One position of the switch. */
interface ModeOption {
    /** The mode. */
    mode: McpMode;

    /** Display label. */
    label: string;

    /** Icon class. Distinct shape per mode, not colour alone. */
    icon: string;

    /** Colour token. */
    color: string;

    /** What this mode permits, for the tooltip. */
    tooltip: string;
}

/**
 * The AI mode switch: an obvious, always-visible control that blocks or enables an AI
 * from changing what is on screen.
 *
 * A permanent fixture of the application toolbar, never inside a settings dialog — a
 * lock the user has to go looking for is not a control.
 */
@Component({
    selector: 'app-ai-mode-switch',
    imports: [CommonModule],
    templateUrl: './ai-mode-switch.component.html',
    styleUrl: './ai-mode-switch.component.scss',
})
export class AiModeSwitchComponent extends ComponentBase {
    constructor(readonly ai: AiSessionService) {
        super();
    }

    /** The three positions. */
    readonly options: readonly ModeOption[] = [
        {
            mode: McpMode.Off,
            label: 'Off',
            icon: ICONS.aiOff,
            color: 'var(--color-text-muted)',
            tooltip: 'The AI can do nothing, not even read.',
        },
        {
            mode: McpMode.Observe,
            label: 'Observe',
            icon: ICONS.aiObserve,
            color: 'var(--color-info)',
            tooltip: 'The AI can read your data and see what you are looking at, but cannot change the interface.',
        },
        {
            mode: McpMode.Collaborate,
            label: 'Collaborate',
            icon: ICONS.aiCollaborate,
            color: 'var(--color-ai)',
            tooltip: 'The AI can read, change what is on screen, and stage proposals for you to execute.',
        },
    ];

    /** The active mode. */
    readonly current = computed(() => this.ai.mode());

    /** The active option. */
    readonly activeOption = computed(
        () => this.options.find(option => option.mode === this.current()) ?? this.options[2]
    );

    /**
     * The reassurance that matters most, and is true in every position: no mode lets
     * an AI execute a data change.
     */
    readonly neverWritesNote = computed(
        () =>
            `In every mode, the AI cannot execute a data change — ` +
            `it can only propose one for you to run. ` +
            `(canExecuteDataChanges: ${MCP_MODE_CAPABILITIES[this.current()].canExecuteDataChanges})`
    );

    /** Whether the switch is reflecting a live connection to the server. */
    readonly isLive = computed(() => this.ai.isConnected());

    /** Selects a mode. */
    select(mode: McpMode): void {
        this.ai.setMode(mode);
    }
}
