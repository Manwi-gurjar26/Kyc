"use client";

import { chooseRoles } from "./actions";

/**
 * Development role switcher.
 *
 * Deliberately plain, and deliberately labelled. Real staff roles come from
 * Google Workspace SSO with MFA and are assigned by a Super Admin; a dropdown
 * that grants Legal's permissions is scaffolding, not a feature, and the API
 * refuses to run its header-based session at all in production.
 */

const ROLES: { value: string; label: string; can: string }[] = [
  { value: "support", label: "Support / RM", can: "personal cases" },
  { value: "compliance", label: "Compliance", can: "personal cases" },
  { value: "legal", label: "Legal", can: "business checks and land papers" },
  { value: "engineer", label: "Engineer", can: "nothing — no review permission" },
  { value: "super_admin", label: "Super Admin", can: "everything" },
];

export function RolePicker({ current }: { current: string[] }) {
  return (
    <form action={chooseRoles} className="rolepicker">
      <div className="field" style={{ marginBottom: 12 }}>
        <label htmlFor="roles">Review as</label>
        <select id="roles" name="roles" defaultValue={current[0] ?? ""}>
          <option value="">(no staff role)</option>
          {ROLES.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label} — can decide {role.can}
            </option>
          ))}
        </select>
      </div>
      <button className="btn ghost" type="submit">
        Switch role
      </button>
    </form>
  );
}
