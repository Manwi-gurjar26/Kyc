import { api, type DevUser } from "../lib/api";
import { IdentityPicker } from "./IdentityPicker";

/**
 * What a page shows when nobody is signed in.
 *
 * Five pages had their own copy of this, and every one ended in "Go back" to
 * `/` — which stopped having an identity picker when the start screen became
 * the customer flow. So "go back and pick one" sent people to a page with no
 * way to pick one. For a customer that is recoverable, because Continue on `/`
 * opens a session; for a reviewer it was a locked door, since the queues need
 * a named person and nothing reachable could name one.
 *
 * So the two audiences get two different ways out:
 *
 *  - customer: start the verification, which is what creates the session;
 *  - staff:    the development identity picker, right here, because there is
 *              no sign-in yet and this is the only place a reviewer arrives.
 *
 * When Better Auth lands, the staff branch becomes a sign-in link and the
 * picker goes with it.
 */
export async function NeedsIdentity({
  audience,
  eyebrow,
  lead,
}: {
  audience: "customer" | "staff";
  eyebrow?: string;
  lead: string;
}) {
  if (audience === "customer") {
    return (
      <div className="card emptystate">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>Start your verification first</h1>
        <p className="lead">{lead}</p>
        <a className="btn" href="/">
          Start verification →
        </a>
      </div>
    );
  }

  /*
   * The list is public on the dev API (no session to send yet). If the API is
   * down the picker still renders with its "add one" form, and says why the
   * list is missing rather than showing an empty one as though nobody exists.
   */
  let users: DevUser[] = [];
  let unavailable = false;
  try {
    ({ users } = await api<{ users: DevUser[] }>("/v1/dev/users", {
      authenticated: false,
    }));
  } catch {
    /** An API error body and a refused connection mean the same thing here. */
    unavailable = true;
  }

  return (
    <div className="card emptystate">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1>Who is reviewing?</h1>
      <p className="lead">{lead}</p>

      {unavailable ? (
        <div className="alert" role="alert">
          The API did not return the list of identities. You can still add one
          below.
        </div>
      ) : null}

      {users.length > 0 ? <h2>Choose an identity</h2> : null}
      <IdentityPicker users={users} currentUserId={null} />
    </div>
  );
}
