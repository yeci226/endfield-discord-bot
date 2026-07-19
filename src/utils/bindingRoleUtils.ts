export interface PrimaryBindingRole {
  binding: any;
  role: any;
}

export function resolveBindingUid(
  primary: PrimaryBindingRole | null | undefined,
  accountId?: unknown,
): string {
  return String(
    primary?.binding?.uid ||
      primary?.role?.roleId ||
      primary?.role?.uid ||
      accountId ||
      "",
  );
}

export function selectAccountByIndex<T>(
  accounts: T[] | null | undefined,
  rawIndex: unknown,
): T | undefined {
  if (!Array.isArray(accounts) || accounts.length === 0) return undefined;

  const index = Number.parseInt(String(rawIndex ?? "0"), 10);
  if (!Number.isInteger(index) || index < 0) return accounts[0];
  return accounts[index] ?? accounts[0];
}

export function normalizeBindingEntries(
  bindings: any[] | null | undefined,
): any[] {
  if (!Array.isArray(bindings)) return [];

  const out: any[] = [];
  for (const item of bindings) {
    if (Array.isArray(item?.bindingList)) {
      out.push(...item.bindingList);
      continue;
    }
    out.push(item);
  }
  return out;
}

export function normalizeBindingRoles(binding: any): any[] {
  const nestedRoles = Array.isArray(binding?.roles)
    ? binding.roles.filter(Boolean)
    : [];
  if (nestedRoles.length > 0) return nestedRoles;

  if (binding?.defaultRole) return [binding.defaultRole];

  const roleId = String(binding?.uid || "");
  const nickname = String(binding?.nickName || binding?.nickname || roleId);
  if (!roleId && !nickname) return [];

  return [
    {
      roleId,
      serverId: String(binding?.channelMasterId || ""),
      nickname,
      level: 0,
      serverName: String(
        binding?.channelName || binding?.gameName || "-",
      ),
    },
  ];
}

export function findPrimaryBindingRole(
  bindings: any[] | null | undefined,
  gameId?: number,
): PrimaryBindingRole | null {
  const normalized = normalizeBindingEntries(bindings);

  for (const binding of normalized) {
    if (gameId !== undefined && Number(binding?.gameId) !== gameId) continue;

    const role = normalizeBindingRoles(binding)[0];
    if (role) return { binding, role };
  }

  return null;
}
