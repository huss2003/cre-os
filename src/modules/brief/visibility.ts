/**
 * Mirror of app.can_read() for job-side assembly. Jobs use the service-role client (bypasses RLS), so every row that
 * goes into a user's private brief/plan is filtered here to exactly what that user could read through RLS (S1/S2).
 */
export interface MemberAccess {
  userId: string;
  role: "owner" | "admin" | "editor" | "viewer";
  allowedClassifications: string[];
  seeAllAccounts: boolean;
  shares: Set<string>; // `${entity_type}:${entity_id}`
}

export interface AccessRow { id: string; classification?: string | null; owner_user_id?: string | null; archived_at?: string | null }

export function canRead(m: MemberAccess, row: AccessRow, entityType: string): boolean {
  if (row.archived_at) return false;
  const cls = row.classification ?? "corporate_confidential";
  if (!m.allowedClassifications.includes(cls)) return false;
  if (m.role === "owner" || m.role === "admin" || m.seeAllAccounts) return true;
  if (row.owner_user_id === m.userId) return true;
  return m.shares.has(`${entityType}:${row.id}`);
}

export function visible<T extends AccessRow>(m: MemberAccess, rows: T[] | null | undefined, entityType: string): T[] {
  return (rows ?? []).filter((r) => canRead(m, r, entityType));
}
