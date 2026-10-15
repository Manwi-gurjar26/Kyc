"use client";

import { useActionState } from "react";
import { createIdentity, selectIdentity, signOut } from "./actions";
import type { ActionResult } from "./actions";
import type { DevUser } from "../lib/api";

/**
 * Development identity picker.
 *
 * Deliberately plain. It is scaffolding, and dressing it up would make it look
 * like a feature rather than the thing that gets deleted when Better Auth
 * lands.
 */
export function IdentityPicker({
  users,
  currentUserId,
}: {
  users: DevUser[];
  currentUserId: string | null;
}) {
  const [state, submit, pending] = useActionState<ActionResult, FormData>(
    async (_prev, formData) => createIdentity(formData),
    {},
  );

  return (
    <>
      {users.length > 0 ? (
        <div className="userlist">
          {users.map((user) => (
            <form action={selectIdentity} key={user.id}>
              <input type="hidden" name="userId" value={user.id} />
              <button
                className="userrow"
                type="submit"
                aria-current={user.id === currentUserId}
              >
                <span>
                  <span className="name">{user.displayName ?? "Unnamed"}</span>
                  <br />
                  <span className="phone">{user.phoneE164}</span>
                </span>
                <span className="go">
                  {user.id === currentUserId ? "selected" : "use this →"}
                </span>
              </button>
            </form>
          ))}
        </div>
      ) : null}

      {currentUserId ? (
        <form action={signOut}>
          <button className="btn ghost" type="submit">
            Switch identity
          </button>
        </form>
      ) : null}

      <h2>Or add one</h2>

      {state.error ? (
        <div className="alert" role="alert">
          {state.error.message}
        </div>
      ) : null}

      <form action={submit}>
        <div className="field">
          <label htmlFor="displayName">Name, as it would appear on Aadhaar</label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            minLength={2}
            defaultValue="Ramesh Kumar Sharma"
          />
        </div>

        <div className="field">
          <label htmlFor="phoneE164">Mobile number</label>
          <input
            id="phoneE164"
            name="phoneE164"
            type="tel"
            required
            placeholder="+919812345678"
            pattern="^\+91[6-9][0-9]{9}$"
          />
          <p className="hint">+91 followed by 10 digits, starting 6–9</p>
        </div>

        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add identity"}
        </button>
      </form>
    </>
  );
}
