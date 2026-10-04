/**
 * Identity key for dog/handler names: two names that produce the same key are the same identity.
 * Order matters: NFKC, trim, collapse whitespace, lower-case (en-GB, so no Turkish I rules).
 *
 * Known limits: lower-casing is not full case-folding ("ß" and "SS" do not collide), and
 * zero-width characters are not stripped.
 */
export function identityKey(input: string): string {
  return input.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
}
