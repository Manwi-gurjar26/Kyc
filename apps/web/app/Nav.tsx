"use client";

import { usePathname } from "next/navigation";

/**
 * Primary navigation.
 *
 * Two groups, not one list. The customer links and the staff links were in a
 * single row, which put "Review queue" next to "Verify" as though they were
 * the same kind of destination. They are not: one is the thing a land owner
 * does once, the other is a colleague's working day, and a customer who clicks
 * into a review queue has been invited to by the interface.
 *
 * The staff group stays visible rather than being hidden behind the role
 * cookie, because this build is the development scaffolding — you have to be
 * able to reach /admin to pick a role in the first place. The API refuses
 * either way, which is where that boundary actually lives.
 */

interface Destination {
  href: string;
  label: string;
}

const CUSTOMER: Destination[] = [
  { href: "/", label: "Verify" },
  { href: "/status", label: "Status" },
  { href: "/commercial", label: "Business" },
  { href: "/documents", label: "Documents" },
];

const STAFF: Destination[] = [
  { href: "/admin", label: "Review queue" },
  { href: "/admin/land", label: "Land review" },
];

/**
 * Whether a link is the page you are on.
 *
 * `/` has to match exactly or it would light up on every route. The rest match
 * on a path boundary, so /admin stays current while you are reading a case at
 * /admin/<id> — the thing a breadcrumb would otherwise be needed for — without
 * /admin also claiming /admin/land, which has its own entry.
 */
function isCurrent(pathname: string, href: string, siblings: Destination[]): boolean {
  if (href === "/") return pathname === "/";
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;

  /** A more specific sibling wins: /admin/land is not /admin. */
  return !siblings.some(
    (other) =>
      other.href !== href &&
      other.href.startsWith(`${href}/`) &&
      (pathname === other.href || pathname.startsWith(`${other.href}/`)),
  );
}

function Group({
  label,
  destinations,
  pathname,
  all,
}: {
  label: string;
  destinations: Destination[];
  pathname: string;
  all: Destination[];
}) {
  return (
    <nav className="navgroup" aria-label={label}>
      {destinations.map((destination) => {
        const current = isCurrent(pathname, destination.href, all);
        return (
          /**
           * A plain anchor, deliberately. next/link would navigate on the
           * client and keep this layout mounted, so the identity chip beside
           * the brand would go on showing whoever was selected when the page
           * first loaded. In a KYC tool, a header that names the wrong person
           * is the worst thing on this screen to get wrong, and a full load
           * costs nothing here.
           */
          <a
            key={destination.href}
            className={current ? "navlink current" : "navlink"}
            href={destination.href}
            aria-current={current ? "page" : undefined}
          >
            {destination.label}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * Routes that are the verification flow itself.
 *
 * The flow is a single task with its own back arrow and progress rail. A row
 * of links to Status, Business and the staff review queues sitting above it
 * invites somebody halfway through proving who they are to wander off, and
 * two competing back affordances is one too many.
 */
function isFlow(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/verify");
}

export function Nav() {
  const pathname = usePathname() ?? "/";

  if (isFlow(pathname)) return null;
  const all = [...CUSTOMER, ...STAFF];

  return (
    <div className="navbar">
      <Group label="Your verification" destinations={CUSTOMER} pathname={pathname} all={all} />

      <div className="navgroup-staff">
        <span className="navgroup-label" aria-hidden="true">
          Staff
        </span>
        <Group label="Staff" destinations={STAFF} pathname={pathname} all={all} />
      </div>
    </div>
  );
}
