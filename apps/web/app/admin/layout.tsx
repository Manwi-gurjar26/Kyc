/**
 * Admin pages get a wider shell, because the queue and the evidence tables
 * need the room. The root layout's `.shell` widens itself when it contains
 * this wrapper, which avoids restructuring the routes just to change a
 * max-width.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="adminroot">{children}</div>;
}
