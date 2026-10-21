export const PREFIX = "notebooklm::";

export function isNotebooklmBank(bankId) {
  return typeof bankId === "string" && bankId.startsWith(PREFIX);
}

export function notebooklmSlug(bankId) {
  return isNotebooklmBank(bankId) ? bankId.slice(PREFIX.length) : null;
}

export function bankAllowed(bankId, allowlist) {
  if (!isNotebooklmBank(bankId)) return false;
  const list = Array.isArray(allowlist) && allowlist.length ? allowlist : ["*"];
  if (list.includes("*")) return true;
  const slug = notebooklmSlug(bankId);
  return list.some((e) => e === bankId || e === slug);
}

export function filterNotebooklmBanks(banks, allowlist) {
  return (banks || []).filter((b) => bankAllowed(b.bank_id || b.id || b.name || "", allowlist));
}
