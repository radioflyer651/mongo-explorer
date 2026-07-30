import { ObjectId } from 'mongodb';

/**
 * A database item that has not been created yet, so it carries no identifier.
 * Application Database entities only — never a Target Database document.
 */
export type NewDbItem<T extends { _id: ObjectId; }> = Omit<T, '_id'>;

/**
 * A database item being upserted: the identifier is present when updating and
 * absent when creating.
 */
export type UpsertDbItem<T extends { _id: ObjectId; }> = Omit<T, '_id'> & { _id?: ObjectId; };

/** An entity that has been persisted, and so certainly has an identifier. */
export type DbItem<T> = T & { _id: ObjectId; };
