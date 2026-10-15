/**
 * PAN encryption.
 *
 * Behind an interface so the placeholder lives in exactly one place instead of
 * inline at the call site, where it was before. When real envelope encryption
 * arrives it is one implementation of this, and nothing else changes.
 */

export interface PanEncryptor {
  readonly name: string;
  /** Returns the value stored in `kyc_records.pan_encrypted`. */
  encrypt(pan: string): Promise<string>;
}

/**
 * NOT ENCRYPTION.
 *
 * Deliberately obvious rather than plausible. A placeholder that looked like
 * ciphertext — base64, a fake key id, anything resembling an encryption envelope —
 * could reach production and nobody would notice, because the column would
 * look exactly as expected. This one announces itself in every row, in every
 * database dump, and in any log line that ever prints the column.
 *
 * It also refuses to run in production, so the failure is a deploy that will
 * not start rather than a database quietly full of plaintext PANs.
 */
export class PlaceholderPanEncryptor implements PanEncryptor {
  readonly name = "placeholder";

  constructor(nodeEnv: string) {
    if (nodeEnv === "production") {
      throw new Error(
        "PlaceholderPanEncryptor refuses to run in production. It does not encrypt anything. " +
          "Implement KmsPanEncryptor before deploying.",
      );
    }
  }

  async encrypt(pan: string): Promise<string> {
    return `UNENCRYPTED_PLACEHOLDER_DO_NOT_SHIP:${pan}`;
  }
}
