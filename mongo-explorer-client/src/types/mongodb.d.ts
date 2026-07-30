/**
 * Declares the mongodb package as an ambient module so shared interfaces can
 * reference ObjectId without the driver being installed in the browser.
 *
 * ObjectId aliases to string. Use it for OUR entity identifiers — it carries
 * semantic meaning that plain string does not.
 *
 * Do NOT use it for a Target Database document's _id. A target _id can be a string,
 * number, date, subdocument, or binary, and typing it as ObjectId would be a lie
 * that leads to corrupted round-trips.
 */
declare module 'mongodb' {
    /** Identifier of an Application Database entity. A hex string in the browser. */
    export type ObjectId = string;

    /** An arbitrary Target Database document. Deliberately unstructured. */
    export type Document = Record<string, unknown>;
}
