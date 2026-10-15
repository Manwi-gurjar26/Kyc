-- ===================================================================
-- The live Aadhaar OTP challenge, moved out of process memory.
-- ===================================================================
--
-- Between "send me an OTP" and "here is the OTP" there is a reference id the
-- gateway gave us, and it has to live somewhere. It was living in a
-- module-level variable in the web app:
--
--     let pendingReference: string | null = null;
--
-- which is one variable shared by every request the process handles. Two
-- people verifying at the same time overwrite each other, and the second
-- person's OTP is then checked against the first person's challenge. That is
-- not a scaling problem to fix later; it is two strangers' identities crossing
-- on a single server.
--
-- So it lives here, keyed by the person it belongs to.
--
-- What is NOT here: the Aadhaar number. The gateway's reference id is an
-- opaque handle, and the four digits we are allowed to keep are already on
-- kyc_records. There is still nowhere in this database that could hold a full
-- Aadhaar number.
--
-- One row per person. Asking for a new OTP replaces the old challenge rather
-- than adding a second, because having two live challenges for one person is
-- not a state anybody wants to reason about — and the gateway invalidates the
-- old one anyway.

CREATE TABLE aadhaar_otp_challenges (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  /** The gateway's opaque handle for this attempt. Not derived from Aadhaar. */
  reference_id text NOT NULL,

  /**
   * The four digits, carried from the request step.
   *
   * A real gateway's verify response contains no Aadhaar number at all, so
   * the last four can only be captured when the OTP is requested. They are
   * written onto kyc_records at that point too; kept here as well so the
   * confirmation can record them even if the record is rebuilt in between.
   */
  last4 text NOT NULL,

  /**
   * Attempts against this challenge.
   *
   * A six-digit OTP has a million values, which is nothing to a script. The
   * gateway limits attempts on its side, but we hold the challenge, so the
   * limit is enforced here as well — the cheap half of defence in depth.
   */
  attempts integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),

  /**
   * When this stops being usable.
   *
   * An OTP challenge that never expires is a permanent open door: somebody
   * who abandons the flow leaves a reference id that would still verify a
   * month later.
   */
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint

/** The sweep that clears abandoned challenges reads this. */
CREATE INDEX aadhaar_otp_challenges_expiry_idx
  ON aadhaar_otp_challenges (expires_at);
--> statement-breakpoint

ALTER TABLE aadhaar_otp_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE aadhaar_otp_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Only the system role touches this. A customer never reads their own
-- challenge — they received the OTP on their phone, and handing the browser
-- the reference id is what the module-level variable was effectively doing.
-- Staff have no business here either: there is nothing in it to review.
CREATE POLICY aadhaar_otp_challenges_system_all ON aadhaar_otp_challenges
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
