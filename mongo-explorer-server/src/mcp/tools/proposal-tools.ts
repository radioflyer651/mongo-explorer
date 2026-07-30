import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    McpToolContext,
    McpToolResult,
    PROPOSE_TOOL,
    READ_ONLY_TOOL,
    defineTool,
    fail,
    guardProposal,
    guardRead,
    ok,
    refuse,
    resolveConnection,
} from '../mcp-tool-context';
import { CreateProposalRequest } from '../proposal.service';
import { ProposalKind } from '../../model/shared-models/mcp/proposal.model';
import { parseExtendedJson } from '../../utils/ejson.util';

/** Fields every proposal carries. */
interface ProposalBaseArgs {
    connectionId: string;
    databaseName: string;
    summary: string;
    rationale: string;
}

/**
 * The only path from an AI to a data change.
 *
 * Every tool here stages a proposal and returns. None of them touch a Target
 * Database. There is deliberately no apply_proposal tool: the user applies proposals
 * from the Proposals panel, and that path runs as actor 'user' because a human
 * pressed the button.
 */
export function registerProposalTools(server: McpServer, context: McpToolContext): void {
    const baseSchema = {
        connectionId: z.string(),
        databaseName: z.string(),
        summary: z.string().min(1).describe('One sentence stating what this does, for the user to read.'),
        rationale: z.string().min(1).describe('Why you are proposing it. An unexplained change is not reviewable.'),
    };

    /** Validates Extended JSON arguments before staging anything. */
    function validateJson(entries: readonly (readonly [string, string | undefined])[]): string | undefined {
        for (const [label, value] of entries) {
            if (value === undefined) {
                continue;
            }

            try {
                parseExtendedJson(value, label);
            } catch (error) {
                return error instanceof Error ? error.message : `Invalid ${label}.`;
            }
        }

        return undefined;
    }

    /** Runs the shared guard chain and stages a proposal. */
    async function stage(connectionIdHex: string, request: Omit<CreateProposalRequest, 'connectionId'>): Promise<McpToolResult> {
        const resolved = await resolveConnection(context, connectionIdHex);

        if (!resolved.ok) {
            return refuse(resolved.refusal);
        }

        const refusal = guardProposal(context, resolved.connection);

        if (refusal) {
            return refuse(refusal);
        }

        try {
            const proposal = await context.proposalService.createProposal({
                ...request,
                connectionId: resolved.connection.connectionId,
            });

            context.activityService.record({
                actor: 'mcp',
                action: `proposal.${proposal.kind}`,
                description: `Staged a proposal: ${proposal.summary}`,
            });

            return ok({
                proposalId: proposal.id,
                status: proposal.status,
                affectedCount: proposal.affectedCount,
                reversal: proposal.reversal,
                note:
                    'Staged for the user. It appears in the Proposals panel with a diff. Only the user can apply ' +
                    'it — there is no tool that executes a proposal.',
            });
        } catch (error) {
            return fail(error, 'Check the operation arguments and retry.');
        }
    }

    /** Refusal for malformed Extended JSON. */
    function invalidJson(message: string): McpToolResult {
        return refuse({
            code: 'invalid_argument',
            message,
            hint: 'Correct the Extended JSON and retry.',
        });
    }

    defineTool<ProposalBaseArgs & { collectionName: string; filterJson: string; updateJson: string; isMany?: boolean; }>(
        server,
        'propose_document_update',
        {
            title: 'Propose a document update',
            description:
                'Stages an update for the user to review and execute. Filter and update are Extended JSON. Set ' +
                'isMany to update every match. The real affected count is computed and shown to the user.',
            inputSchema: {
                ...baseSchema,
                collectionName: z.string(),
                filterJson: z.string(),
                updateJson: z.string().describe('Update document, for example {"$set":{"status":"archived"}}.'),
                isMany: z.boolean().optional(),
            },
            annotations: PROPOSE_TOOL,
        },
        async args => {
            const invalid = validateJson([
                ['filter', args.filterJson],
                ['update', args.updateJson],
            ]);

            if (invalid) {
                return invalidJson(invalid);
            }

            return await stage(args.connectionId, {
                kind: ProposalKind.DocumentUpdate,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: {
                    kind: ProposalKind.DocumentUpdate,
                    filterJson: args.filterJson,
                    updateJson: args.updateJson,
                    isMany: args.isMany ?? false,
                },
            });
        }
    );

    defineTool<ProposalBaseArgs & { collectionName: string; documentsJson: string; }>(
        server,
        'propose_document_insert',
        {
            title: 'Propose a document insert',
            description: 'Stages one or more documents for the user to insert. Documents are Extended JSON.',
            inputSchema: {
                ...baseSchema,
                collectionName: z.string(),
                documentsJson: z.string().describe('An Extended JSON object or array of objects.'),
            },
            annotations: PROPOSE_TOOL,
        },
        async args => {
            const invalid = validateJson([['documents', args.documentsJson]]);

            if (invalid) {
                return invalidJson(invalid);
            }

            return await stage(args.connectionId, {
                kind: ProposalKind.DocumentInsert,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: { kind: ProposalKind.DocumentInsert, documentsJson: args.documentsJson },
            });
        }
    );

    defineTool<ProposalBaseArgs & { collectionName: string; filterJson: string; documentJson: string; }>(
        server,
        'propose_document_replace',
        {
            title: 'Propose a document replacement',
            description: 'Stages a wholesale replacement of one document.',
            inputSchema: {
                ...baseSchema,
                collectionName: z.string(),
                filterJson: z.string(),
                documentJson: z.string(),
            },
            annotations: PROPOSE_TOOL,
        },
        async args => {
            const invalid = validateJson([
                ['filter', args.filterJson],
                ['document', args.documentJson],
            ]);

            if (invalid) {
                return invalidJson(invalid);
            }

            return await stage(args.connectionId, {
                kind: ProposalKind.DocumentReplace,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: {
                    kind: ProposalKind.DocumentReplace,
                    filterJson: args.filterJson,
                    documentsJson: args.documentJson,
                },
            });
        }
    );

    defineTool<ProposalBaseArgs & { collectionName: string; filterJson: string; isMany?: boolean; }>(
        server,
        'propose_document_delete',
        {
            title: 'Propose a document deletion',
            description:
                'Stages a deletion for the user to review. Set isMany to delete every match. The user sees the ' +
                'real affected count and must confirm; a bulk delete requires them to type the collection name.',
            inputSchema: {
                ...baseSchema,
                collectionName: z.string(),
                filterJson: z.string(),
                isMany: z.boolean().optional(),
            },
            annotations: PROPOSE_TOOL,
        },
        async args => {
            const invalid = validateJson([['filter', args.filterJson]]);

            if (invalid) {
                return invalidJson(invalid);
            }

            return await stage(args.connectionId, {
                kind: ProposalKind.DocumentDelete,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: {
                    kind: ProposalKind.DocumentDelete,
                    filterJson: args.filterJson,
                    isMany: args.isMany ?? false,
                },
            });
        }
    );

    defineTool<ProposalBaseArgs & { collectionName: string; keyJson: string; indexName?: string; }>(
        server,
        'propose_index_create',
        {
            title: 'Propose an index',
            description:
                'Stages an index creation. The key is Extended JSON, for example {"createdAt":-1}. Pair this with ' +
                'explain_query output so the user can see why the index would help.',
            inputSchema: {
                ...baseSchema,
                collectionName: z.string(),
                keyJson: z.string(),
                indexName: z.string().optional(),
            },
            annotations: PROPOSE_TOOL,
        },
        async args => {
            const invalid = validateJson([['index key', args.keyJson]]);

            if (invalid) {
                return invalidJson(invalid);
            }

            return await stage(args.connectionId, {
                kind: ProposalKind.IndexCreate,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: { kind: ProposalKind.IndexCreate, indexJson: args.keyJson, indexName: args.indexName },
            });
        }
    );

    defineTool<ProposalBaseArgs & { collectionName: string; indexName: string; }>(
        server,
        'propose_index_drop',
        {
            title: 'Propose dropping an index',
            description: 'Stages an index drop.',
            inputSchema: { ...baseSchema, collectionName: z.string(), indexName: z.string() },
            annotations: PROPOSE_TOOL,
        },
        async args =>
            await stage(args.connectionId, {
                kind: ProposalKind.IndexDrop,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: { kind: ProposalKind.IndexDrop, indexName: args.indexName },
            })
    );

    defineTool<ProposalBaseArgs & { collectionName: string; action: 'create' | 'rename' | 'drop'; newName?: string; }>(
        server,
        'propose_collection_operation',
        {
            title: 'Propose a collection operation',
            description:
                'Stages a collection create, rename, or drop. A drop requires the user to type the collection ' +
                'name to confirm.',
            inputSchema: {
                ...baseSchema,
                collectionName: z.string(),
                action: z.enum(['create', 'rename', 'drop']),
                newName: z.string().optional(),
            },
            annotations: PROPOSE_TOOL,
        },
        async args => {
            if (args.action === 'rename' && !args.newName) {
                return refuse({
                    code: 'invalid_argument',
                    message: 'A rename requires newName.',
                    hint: 'Supply newName and retry.',
                });
            }

            return await stage(args.connectionId, {
                kind: ProposalKind.CollectionOperation,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: {
                    kind: ProposalKind.CollectionOperation,
                    collectionAction: args.action,
                    newName: args.newName,
                },
            });
        }
    );

    defineTool<ProposalBaseArgs & { collectionName: string; pipelineJson: string; }>(
        server,
        'propose_pipeline_run',
        {
            title: 'Propose running a write pipeline',
            description:
                'Stages an aggregation pipeline that contains $out or $merge. Such a pipeline writes to a ' +
                'collection, so it cannot be previewed or executed by an AI — only proposed.',
            inputSchema: {
                ...baseSchema,
                collectionName: z.string(),
                pipelineJson: z.string().describe('Extended JSON array of pipeline stages.'),
            },
            annotations: PROPOSE_TOOL,
        },
        async args => {
            const invalid = validateJson([['pipeline', args.pipelineJson]]);

            if (invalid) {
                return invalidJson(invalid);
            }

            return await stage(args.connectionId, {
                kind: ProposalKind.PipelineRun,
                databaseName: args.databaseName,
                collectionName: args.collectionName,
                summary: args.summary,
                rationale: args.rationale,
                operation: { kind: ProposalKind.PipelineRun, pipelineJson: args.pipelineJson },
            });
        }
    );

    defineTool<ProposalBaseArgs & { shellInput: string; }>(
        server,
        'propose_shell_command',
        {
            title: 'Propose a shell command',
            description: 'Stages a shell command that is not on the read-only allow-list, for the user to execute.',
            inputSchema: { ...baseSchema, shellInput: z.string() },
            annotations: PROPOSE_TOOL,
        },
        async args =>
            await stage(args.connectionId, {
                kind: ProposalKind.ShellCommand,
                databaseName: args.databaseName,
                summary: args.summary,
                rationale: args.rationale,
                operation: { kind: ProposalKind.ShellCommand, shellInput: args.shellInput },
            })
    );

    defineTool<Record<string, never>>(
        server,
        'get_pending_proposals',
        {
            title: 'Get pending proposals',
            description: "Lists proposals awaiting the user's decision, with their status and reversibility.",
            inputSchema: {},
            annotations: { ...READ_ONLY_TOOL, openWorldHint: false },
        },
        async () => {
            const refusal = guardRead(context);
            return refusal ? refuse(refusal) : ok(context.proposalService.getAll());
        }
    );

    defineTool<{ proposalId: string; }>(
        server,
        'withdraw_proposal',
        {
            title: 'Withdraw a proposal',
            description: 'Retracts a proposal you staged, for example after realising it was wrong.',
            inputSchema: { proposalId: z.string() },
            annotations: { ...PROPOSE_TOOL, idempotentHint: true },
        },
        async args => {
            const refusal = guardRead(context);

            if (refusal) {
                return refuse(refusal);
            }

            return context.proposalService.withdrawProposal(args.proposalId)
                ? ok({ proposalId: args.proposalId, withdrawn: true })
                : refuse({
                    code: 'invalid_argument',
                    message: 'That proposal does not exist or is no longer pending.',
                    hint: 'Call get_pending_proposals to see current proposals.',
                });
        }
    );
}
