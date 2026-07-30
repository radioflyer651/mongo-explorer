/**
 * Verifies that every Target Database write is actor-gated.
 *
 * Purpose: assert mechanically that "an AI cannot write to a Target Database" holds,
 * rather than trusting it to review. Every exported method in src/explorer/ whose
 * name looks like a write must call assertUserActor or assertWriteAllowed.
 *
 * Inputs: none. Run from the server project root.
 * Setup: none beyond the project's dev dependencies.
 * Exit code: 0 when the gate is intact, 1 when a write method is unguarded.
 */

import fs from 'fs';
import path from 'path';

/** Method-name prefixes that indicate a write. */
const WRITE_PREFIXES = [
    'insert',
    'update',
    'delete',
    'drop',
    'create',
    'rename',
    'replace',
    'bulk',
    'kill',
    'runWrite',
];

/** Guard calls that satisfy the requirement. */
const GUARDS = ['assertUserActor', 'assertWriteAllowed'];

/** Files exempt from the check, with the reason. */
const EXEMPT_FILES = new Set(['operation-actor.ts', 'explorer-base.ts']);

/** One unguarded write found by the scan. */
interface Violation {
    file: string;
    method: string;
    line: number;
}

/** Walks a directory tree for TypeScript files. */
function collectFiles(directory: string): string[] {
    const found: string[] = [];

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            found.push(...collectFiles(full));
        } else if (entry.name.endsWith('.ts') && !EXEMPT_FILES.has(entry.name)) {
            found.push(full);
        }
    }

    return found;
}

/**
 * Finds write-shaped methods and checks each body for a guard call. Brace counting
 * is sufficient here: the explorer services are deliberately boring, and a method
 * complex enough to defeat this would be worth rewriting anyway.
 */
function findViolations(filePath: string): Violation[] {
    const source = fs.readFileSync(filePath, 'utf-8');
    const lines = source.split('\n');
    const violations: Violation[] = [];

    const signature = new RegExp(`^\\s{4}(?:async\\s+)?(${WRITE_PREFIXES.join('|')})[A-Za-z0-9_]*\\s*\\(`);

    for (let index = 0; index < lines.length; index += 1) {
        const match = signature.exec(lines[index]);

        if (!match) {
            continue;
        }

        const methodName = /^\s{4}(?:async\s+)?([A-Za-z0-9_]+)/.exec(lines[index])?.[1] ?? 'unknown';
        const body = readMethodBody(lines, index);

        if (!GUARDS.some(guard => body.includes(guard))) {
            violations.push({ file: filePath, method: methodName, line: index + 1 });
        }
    }

    return violations;
}

/**
 * Returns the text of a method body starting at a signature line.
 *
 * Brace counting cannot begin until the parameter list closes: an inline object type
 * such as `options: { name?: string; }` would otherwise look like the body opening
 * and closing immediately, and the method would be reported as unguarded when it is
 * not. Parentheses are balanced first, then the next brace opens the body.
 */
function readMethodBody(lines: string[], signatureIndex: number): string {
    let parenDepth = 0;
    let braceDepth = 0;
    let inParameters = false;
    let inBody = false;
    const collected: string[] = [];

    for (let index = signatureIndex; index < lines.length; index += 1) {
        const line = lines[index];
        collected.push(line);

        for (const character of line) {
            if (!inBody) {
                if (character === '(') {
                    parenDepth += 1;
                    inParameters = true;
                    continue;
                }

                if (character === ')') {
                    parenDepth -= 1;
                    continue;
                }

                /* The body opens at the first brace after the parameters balance. */
                if (character === '{' && inParameters && parenDepth === 0) {
                    inBody = true;
                    braceDepth = 1;
                }

                continue;
            }

            if (character === '{') {
                braceDepth += 1;
            } else if (character === '}') {
                braceDepth -= 1;
            }
        }

        if (inBody && braceDepth <= 0) {
            break;
        }
    }

    return collected.join('\n');
}

/** Runs the check and reports. */
function main(): void {
    const explorerDirectory = path.resolve(__dirname, '..', 'src', 'explorer');

    if (!fs.existsSync(explorerDirectory)) {
        console.error(`Cannot find ${explorerDirectory}.`);
        process.exit(1);
    }

    const files = collectFiles(explorerDirectory);
    const violations = files.flatMap(findViolations);

    if (violations.length === 0) {
        console.log(`Actor gate intact: ${files.length} file(s) scanned, every write method guarded.`);
        return;
    }

    console.error('Unguarded Target Database write methods found.\n');

    for (const violation of violations) {
        const relative = path.relative(process.cwd(), violation.file);
        console.error(`  ${relative}:${violation.line}  ${violation.method}()`);
    }

    console.error(
        '\nEvery write method in src/explorer/ must call assertUserActor or assertWriteAllowed as its\n' +
        'first statement. This is what makes AI-originated writes structurally impossible rather than\n' +
        'merely disallowed. See workspace/mcp-server-spec.md, Actor-Gated Write Path.'
    );

    process.exit(1);
}

main();
