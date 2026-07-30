import { injectable } from 'inversify';
import bcrypt from 'bcryptjs';
import { ObjectId } from 'mongodb';
import { DbService } from './db-service';
import { MongoHelper } from '../mongo-helper';
import { DbCollectionNames } from '../model/db-collection-names.constants';
import { AppUser } from '../model/shared-models/auth/user.model';
import { nowIso } from '../utils/misc.util';

/**
 * The application's own user record. Single-user by design: this exists to hold
 * the local lock credential, not to support multi-tenancy.
 */
@injectable()
export class AuthDbService extends DbService {
    constructor(dbHelper: MongoHelper) {
        super(dbHelper);
    }

    /** Returns the single application user, creating it on first run. */
    async getOrCreateUser(defaultUserName: string): Promise<AppUser> {
        const existing = await this.dbHelper.findDataItem<AppUser>(
            DbCollectionNames.Users,
            {},
            { findOne: true }
        );

        if (existing) {
            return existing as AppUser;
        }

        const created: AppUser = {
            _id: new ObjectId(),
            userName: defaultUserName,
            createdAt: nowIso(),
        };

        await this.dbHelper.upsertDataItem(DbCollectionNames.Users, created);
        return created;
    }

    /** Verifies a password against the stored hash. */
    async verifyPassword(user: AppUser, password: string): Promise<boolean> {
        if (!user.passwordHash) {
            return true;
        }

        return await bcrypt.compare(password, user.passwordHash);
    }

    /** Sets or clears the local lock password. */
    async setPassword(userId: ObjectId, password: string | undefined): Promise<void> {
        const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

        await this.dbHelper.updateDataItems<AppUser>(
            DbCollectionNames.Users,
            { _id: userId },
            passwordHash
                ? { $set: { passwordHash } }
                : { $unset: { passwordHash: '' } }
        );
    }

    /** Records a successful authentication. */
    async recordLogin(userId: ObjectId): Promise<void> {
        await this.dbHelper.updateDataItems<AppUser>(
            DbCollectionNames.Users,
            { _id: userId },
            { $set: { lastLoginAt: nowIso() } }
        );
    }
}
