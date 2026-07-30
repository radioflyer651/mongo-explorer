import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    McpToolContext,
    McpToolResult,
    READ_ONLY_TOOL,
    UI_CHANGE_TOOL,
    defineTool,
    fail,
    guardRead,
    guardUiChange,
    ok,
    refuse,
    resolveConnection,
} from '../mcp-tool-context';
import { WriteStagePresentError } from '../../explorer/pipeline.service';
import { PipelineStage } from '../../model/shared-models/explorer/pipeline.model';
import { ShellCommandClassification, ShellTier } from '../../model/shared-models/explorer/shell.model';
import { newId } from '../../utils/misc.util';

/** One stage as supplied by a caller, before defaults are applied. */
interface StageArg {
    id?: string;
    operator: string;
    body: string;
    isEnabled?: boolean;
    comment?: string;
}

/** Zod shape for one builder stage. */
const stageSchema = z.object({
    id: z.string().optional(),
    operator: z.string().describe("Operator including the dollar sign, for example '$match'."),
    body: z.string().describe('Stage body as Extended JSON.'),
    isEnabled: z.boolean().optional(),
    comment: z.string().optional(),
});

/** Fills in defaults for stages supplied by a caller. */
function toStages(raw: readonly StageArg[]): PipelineStage[] {
    return raw.map(stage => ({
        id: stage.id ?? newId(),
        operator: stage.operator,
        body: stage.body,
        isEnabled: stage.isEnabled ?? true,
        comment: stage.comment,
    }));
}

/** Aggregation pipeline and shell tools. */
export function registerPipelineAndShellTools(server: McpServer, context: McpToolContext): void {
    const revisionSchema = { expectedRevision: z.number().int().optional() };
    const collectionSchema = {
        connectionId: z.string(),
        databaseName: z.string(),
        collectionName: z.string(),
    };

    /** Sends a pipeline mutation and logs attribution when it lands. */
    async function dispatch(
        commandId: string,
        args: Record<string, unknown>,
        description: string,
        hint: string
    ): Promise<McpToolResult> {
        const result = await context.sessionService.requestMutation(commandId, args, description);

        if (!result.applied) {
            return refuse({
                code: 'invalid_argument',
                message: result.error ?? 'The application refused the change.',
                hint,
            });
        }

        context.activityService.record({
            actor: 'mcp',
            action: commandId,
            description,
            isUndoable: result.undoPayload !== undefined,
            undoPayload: result.undoPayload,
        });

        return ok({ applied: true, description });
    }

    defineTool<Record<string, never>>(
        server,
        'get_pipeline',
        {
            title: 'Get the aggregation pipeline',
            description: 'Returns the current aggregation builder state, stage by stage.',
            inputSchema: {},
            annotations: READ_ONLY_TOOL,
        },
        async () => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const state = context.sessionService.getState();

            return state.pipeline
                ? ok(state.pipeline)
                : refuse({
                    code: 'no_active_session',
                    message: 'The aggregation builder is not open.',
                    hint: 'Ask the user to open the pipeline builder, or use set_pipeline to populate it.',
                });
        }
    );

    defineTool<{ stages: StageArg[]; expectedRevision?: number; }>(
        server,
        'set_pipeline',
        {
            title: 'Replace the pipeline',
            description:
                'Replaces every stage in the aggregation builder. Refused when the user has unsaved pipeline ' +
                'edits. Prefer add_stage or update_stage when you only mean to change part of it — the user\'s ' +
                'work on the other stages should survive your contribution.',
            inputSchema: { stages: z.array(stageSchema), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = guardUiChange(context, {
                expectedRevision: args.expectedRevision,
                dirtySurfaces: ['pipelineBuilder'],
                description: 'Replace the whole pipeline',
            });

            if (refusal) {
                return refuse(refusal);
            }

            const stages = toStages(args.stages);
            const dispatched = await dispatch(
                'pipeline.set',
                { stages },
                `Replaced the pipeline with ${stages.length} stage${stages.length === 1 ? '' : 's'}`,
                'Call get_app_state and reconsider.'
            );

            if (dispatched.isError) {
                return dispatched;
            }

            const writeStages = context.pipelineService.findWriteStages(stages);

            return ok({
                applied: true,
                stageCount: stages.length,
                hasWriteStage: writeStages.length > 0,
                writeStages,
                note: writeStages.length
                    ? 'This pipeline writes to a collection. It cannot be previewed or explained, and only the user can run it.'
                    : undefined,
            });
        }
    );

    defineTool<{ stage: StageArg; atIndex?: number; expectedRevision?: number; }>(
        server,
        'add_stage',
        {
            title: 'Add a pipeline stage',
            description: 'Appends or inserts one stage, leaving the user\'s other stages untouched.',
            inputSchema: { stage: stageSchema, atIndex: z.number().int().min(0).optional(), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = guardUiChange(context, {
                expectedRevision: args.expectedRevision,
                description: `Add a ${args.stage.operator} stage`,
            });

            if (refusal) {
                return refuse(refusal);
            }

            const [stage] = toStages([args.stage]);

            return await dispatch(
                'pipeline.addStage',
                { stage, atIndex: args.atIndex },
                `Added a ${stage.operator} stage`,
                'Call get_pipeline to see the current stages.'
            );
        }
    );

    defineTool<{ stageIndex: number; stage: StageArg; expectedRevision?: number; }>(
        server,
        'update_stage',
        {
            title: 'Update a pipeline stage',
            description: 'Rewrites one stage by index.',
            inputSchema: { stageIndex: z.number().int().min(0), stage: stageSchema, ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = guardUiChange(context, {
                expectedRevision: args.expectedRevision,
                description: `Update stage ${args.stageIndex}`,
            });

            if (refusal) {
                return refuse(refusal);
            }

            const [stage] = toStages([args.stage]);

            return await dispatch(
                'pipeline.updateStage',
                { stageIndex: args.stageIndex, stage },
                `Updated stage ${args.stageIndex} to ${stage.operator}`,
                'Call get_pipeline to check the stage count.'
            );
        }
    );

    defineTool<{ stageIndex: number; isEnabled: boolean; expectedRevision?: number; }>(
        server,
        'toggle_stage',
        {
            title: 'Enable or disable a stage',
            description:
                'Enables or disables a stage without deleting it. Bisecting a broken pipeline this way is the ' +
                'normal debugging method, and it does not lose the user\'s work.',
            inputSchema: { stageIndex: z.number().int().min(0), isEnabled: z.boolean(), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = guardUiChange(context, {
                expectedRevision: args.expectedRevision,
                description: `Toggle stage ${args.stageIndex}`,
            });

            if (refusal) {
                return refuse(refusal);
            }

            return await dispatch(
                'pipeline.toggleStage',
                { stageIndex: args.stageIndex, isEnabled: args.isEnabled },
                `${args.isEnabled ? 'Enabled' : 'Disabled'} stage ${args.stageIndex}`,
                'Call get_pipeline to check the stage count.'
            );
        }
    );

    defineTool<{ stageIndex: number; expectedRevision?: number; }>(
        server,
        'remove_stage',
        {
            title: 'Remove a pipeline stage',
            description: 'Deletes one stage by index. Prefer toggle_stage when you only mean to test without it.',
            inputSchema: { stageIndex: z.number().int().min(0), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = guardUiChange(context, {
                expectedRevision: args.expectedRevision,
                description: `Remove stage ${args.stageIndex}`,
            });

            if (refusal) {
                return refuse(refusal);
            }

            return await dispatch(
                'pipeline.removeStage',
                { stageIndex: args.stageIndex },
                `Removed stage ${args.stageIndex}`,
                'Call get_pipeline to check the stage count.'
            );
        }
    );

    defineTool<{
        connectionId: string;
        databaseName: string;
        collectionName: string;
        stages: StageArg[];
        upToStageIndex?: number;
        sampleSize?: number;
    }>(
        server,
        'preview_pipeline',
        {
            title: 'Preview a pipeline',
            description:
                'Runs a bounded, sampled preview of a pipeline prefix. Pass upToStageIndex to run only part of ' +
                'the pipeline — running to stage 3, inspecting the output, and fixing stage 3 is how a pipeline ' +
                'is debugged. This is a preview: never report its count as a result count. Refused for ' +
                'pipelines containing $out or $merge.',
            inputSchema: {
                ...collectionSchema,
                stages: z.array(stageSchema),
                upToStageIndex: z.number().int().min(0).optional(),
                sampleSize: z.number().int().min(1).max(500).optional(),
            },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.pipelineService.previewPipeline(resolved.connection, {
                        connectionId: resolved.connection.connectionId,
                        databaseName: args.databaseName,
                        collectionName: args.collectionName,
                        stages: toStages(args.stages),
                        upToStageIndex: args.upToStageIndex,
                        sampleSize: args.sampleSize ?? 100,
                    })
                );
            } catch (error) {
                if (error instanceof WriteStagePresentError) {
                    return refuse({
                        code: 'write_stage_present',
                        message: error.message,
                        hint:
                            'Use propose_pipeline_run to stage this for the user to execute. There is no way to ' +
                            'preview a write pipeline.',
                        detail: { stages: error.stages },
                    });
                }

                return fail(error, 'Check that each stage body is valid Extended JSON.');
            }
        }
    );

    defineTool<{ connectionId: string; databaseName: string; collectionName: string; stages: StageArg[]; }>(
        server,
        'explain_pipeline',
        {
            title: 'Explain a pipeline',
            description:
                'Returns the execution plan for a pipeline with per-stage notes about index usage. Refused for ' +
                'pipelines containing $out or $merge.',
            inputSchema: { ...collectionSchema, stages: z.array(stageSchema) },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            try {
                return ok(
                    await context.pipelineService.explainPipeline(resolved.connection, {
                        connectionId: resolved.connection.connectionId,
                        databaseName: args.databaseName,
                        collectionName: args.collectionName,
                        stages: toStages(args.stages),
                        sampleSize: 100,
                    })
                );
            } catch (error) {
                if (error instanceof WriteStagePresentError) {
                    return refuse({
                        code: 'write_stage_present',
                        message: error.message,
                        hint: 'Remove the write stage to explain the read portion, or propose the run instead.',
                        detail: { stages: error.stages },
                    });
                }

                return fail(error, 'Check that each stage body is valid Extended JSON.');
            }
        }
    );

    defineTool<{ databaseName: string; collectionName: string; stages: StageArg[]; language: 'node' | 'mongosh' | 'python' | 'json'; }>(
        server,
        'export_pipeline_code',
        {
            title: 'Export a pipeline as code',
            description: 'Generates runnable code for a pipeline in Node, mongosh, Python, or plain JSON.',
            inputSchema: {
                databaseName: z.string(),
                collectionName: z.string(),
                stages: z.array(stageSchema),
                language: z.enum(['node', 'mongosh', 'python', 'json']),
            },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            try {
                return ok(
                    context.pipelineService.exportPipeline(
                        toStages(args.stages),
                        args.databaseName,
                        args.collectionName,
                        args.language
                    )
                );
            } catch (error) {
                return fail(error, 'Check that each stage body is valid Extended JSON.');
            }
        }
    );

    /* ---------- Shell ---------- */

    defineTool<Record<string, never>>(
        server,
        'get_shell_transcript',
        {
            title: 'Get the shell transcript',
            description:
                'Returns the shell history: what was submitted, by whom, how it was classified, and what came ' +
                'back. Use this to reason about commands the user ran.',
            inputSchema: {},
            annotations: READ_ONLY_TOOL,
        },
        async () => {
            const refusal = guardRead(context);
            return refusal ? refuse(refusal) : ok(context.shellService.getTranscript());
        }
    );

    defineTool<{ input: string; }>(
        server,
        'classify_shell_command',
        {
            title: 'Classify a shell command',
            description:
                'Reports whether a command is on the read-only allow-list, is a recognised write, or is ' +
                'unclassifiable. Check this before choosing between run_shell_command and propose_shell_command.',
            inputSchema: { input: z.string() },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);
            return refusal ? refuse(refusal) : ok(context.shellService.classify(args.input));
        }
    );

    defineTool<{ connectionId: string; databaseName: string; input: string; }>(
        server,
        'run_shell_command',
        {
            title: 'Run a read-only shell command',
            description:
                'Executes a command against a Target Database through the Tier A command runner. Only commands ' +
                'on the read-only allow-list are executed; anything else — including anything unrecognised — is ' +
                'refused, because the list is an allow-list, not a deny-list. Input is a command document as ' +
                'Extended JSON, for example {"collStats":"orders"}.',
            inputSchema: {
                connectionId: z.string(),
                databaseName: z.string(),
                input: z.string(),
            },
            annotations: READ_ONLY_TOOL,
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            const { classification, commandName } = context.shellService.classify(args.input);

            if (classification !== ShellCommandClassification.ReadOnly) {
                return refuse({
                    code: classification === ShellCommandClassification.Write ? 'writes_prohibited' : 'unclassifiable_command',
                    message:
                        classification === ShellCommandClassification.Write
                            ? `'${commandName}' writes to the database, so an AI cannot execute it.`
                            : `'${commandName ?? 'the input'}' is not on the read-only allow-list. Unrecognised commands are refused.`,
                    hint: "Use propose_shell_command to stage it, or set_shell_input to put it in the user's input box.",
                    detail: { commandName, classification },
                });
            }

            const resolved = await resolveConnection(context, args.connectionId);

            if (!resolved.ok) {
                return refuse(resolved.refusal);
            }

            return ok(
                await context.shellService.execute(
                    resolved.connection,
                    {
                        connectionId: resolved.connection.connectionId,
                        databaseName: args.databaseName,
                        input: args.input,
                        tier: ShellTier.CommandRunner,
                    },
                    'mcp'
                )
            );
        }
    );

    defineTool<{ input: string; expectedRevision?: number; }>(
        server,
        'set_shell_input',
        {
            title: 'Write into the shell input',
            description:
                'Puts a command into the user\'s shell input box without running it. The user reads it and ' +
                'presses Enter. Together with propose_shell_command this is the only way to get a write or ' +
                'unclassifiable command in front of the user.',
            inputSchema: { input: z.string(), ...revisionSchema },
            annotations: UI_CHANGE_TOOL,
        },
        async args => {
            const refusal = guardUiChange(context, {
                expectedRevision: args.expectedRevision,
                dirtySurfaces: ['shellInput'],
                description: 'Write into the shell input',
            });

            if (refusal) {
                return refuse(refusal);
            }

            const dispatched = await dispatch(
                'shell.setInput',
                { input: args.input },
                'Wrote a command into the shell input',
                'Ask the user to open the shell panel first.'
            );

            if (dispatched.isError) {
                return dispatched;
            }

            return ok({
                applied: true,
                note: 'The command is staged in the input box. The user must run it.',
            });
        }
    );
}
