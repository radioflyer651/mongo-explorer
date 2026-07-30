import crypto from 'crypto';
import { injectable } from 'inversify';

/**
 * Encrypts stored connection secrets at rest.
 *
 * Required despite the application being single-user: the threat is anything that
 * can read the file — a backup sync, another process, a shared machine — none of
 * which care how many users there are.
 */
@injectable()
export class SecretCipher {
    constructor(encryptionKey: string) {
        this.key = crypto.createHash('sha256').update(encryptionKey, 'utf-8').digest();
    }

    private readonly key: Buffer;

    /** Version marker, so the format can change without breaking stored values. */
    private static readonly version = 'v1';

    /** Encrypts plain text into a self-describing, storable string. */
    encrypt(plainText: string): string {
        const initialisationVector = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, initialisationVector);

        const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
        const authenticationTag = cipher.getAuthTag();

        return [
            SecretCipher.version,
            initialisationVector.toString('base64'),
            authenticationTag.toString('base64'),
            encrypted.toString('base64'),
        ].join(':');
    }

    /** Decrypts a value produced by encrypt. Throws when the value is corrupt. */
    decrypt(cipherText: string): string {
        const parts = cipherText.split(':');

        if (parts.length !== 4 || parts[0] !== SecretCipher.version) {
            throw new Error('Stored secret is not in a recognised format.');
        }

        const initialisationVector = Buffer.from(parts[1], 'base64');
        const authenticationTag = Buffer.from(parts[2], 'base64');
        const encrypted = Buffer.from(parts[3], 'base64');

        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, initialisationVector);
        decipher.setAuthTag(authenticationTag);

        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
    }

    /** True when the value looks like output from encrypt. */
    isEncrypted(value: string): boolean {
        return value.startsWith(`${SecretCipher.version}:`);
    }
}
