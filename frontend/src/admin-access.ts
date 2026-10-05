export const adminAccessRequired =
  "需由空间所有者在“管理中心 → 隐私与安全”中允许管理员代管。";

export function canDelegate(space: Record<string, any> | null | undefined) {
  return space?.can_delegate === true;
}
export function canManageAdminAccess(
  access: Record<string, any> | null | undefined,
  space: { role: string; administration?: boolean },
) {
  return (
    access?.can_manage === true &&
    space.role === "owner" &&
    space.administration !== true
  );
}
export function adminAccessRequest(
  access: Record<string, any>,
  space: { role: string; administration?: boolean },
  enabled: boolean,
) {
  if (!canManageAdminAccess(access, space))
    throw new Error("仅空间所有者的普通账号可以修改代管授权");
  if (
    typeof enabled !== "boolean" ||
    !Number.isSafeInteger(access.version) ||
    access.version < 0
  )
    throw new Error("授权状态不完整，请重新读取");
  return { enabled, version: access.version };
}
export function isDelegationDenied(
  path: string,
  status: number,
  spaceId: string,
) {
  if (status !== 403) return false;
  const clean = path.split("?")[0];
  return (
    clean === `/spaces/${spaceId}` ||
    clean.startsWith(`/spaces/${spaceId}/`) ||
    clean === `/admin/spaces/${spaceId}`
  );
}
