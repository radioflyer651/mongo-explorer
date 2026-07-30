import { NextFunction, Request, Response } from 'express';
import { ZodType } from 'zod';

/**
 * Validates a request body against a schema and replaces it with the parsed value,
 * so handlers see the coerced version.
 *
 * The envelope is validated strictly. Target Database document contents are NOT
 * validated: arbitrary user documents have no schema to validate against, and
 * validating the envelope strictly is precisely what makes it safe to pass the
 * document body through untouched.
 */
export function validateBody<T>(schema: ZodType<T>) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            res.status(400).json({
                message: 'Request body is not valid.',
                errors: result.error.issues.map(issue => ({
                    path: issue.path.join('.'),
                    message: issue.message,
                })),
            });
            return;
        }

        req.body = result.data;
        next();
    };
}
