import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, parsePasswordHash } from "./crypto";
import { createPasswordAuth } from "./password";
import { SESSION_COOKIE } from "./session";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
let hash: NonNullable<ReturnType<typeof parsePasswordHash>>;
beforeAll(async () => { hash = parsePasswordHash(await hashPassword("a long enough password"))!; });

const cookieOf = (setCookie: string) => setCookie.split(";")[0];
const requestWith = (cookie?: string) => new Request("https://club.example/api/admin/session", { headers: cookie ? { Cookie: cookie } : {} });

describe("password provider", () => {
  it("checks the password", async () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW });
    expect(auth.kind).toBe("password");
    expect(await auth.checkPassword("a long enough password")).toBe(true);
    expect(await auth.checkPassword("a long enough passwore")).toBe(false);
  });

  it("starts a session whose cookie authenticates as admin, bound to its session id", async () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW });
    const { session, setCookie } = await auth.startSession();
    expect(session.identity).toBe("admin");
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.[\\w-]+\\.[\\w-]+; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800$`));
    expect(await auth.authenticate(requestWith(cookieOf(setCookie)))).toEqual(session);
    expect(session.csrfBinding).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("does not authenticate without a cookie, with a garbage cookie, an expired one, or one signed by another secret", async () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW });
    const { setCookie } = await auth.startSession();
    expect(await auth.authenticate(requestWith())).toBeNull();
    expect(await auth.authenticate(requestWith(`${SESSION_COOKIE}=junk`))).toBeNull();
    const later = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW + 8 * 3600_000 });
    expect(await later.authenticate(requestWith(cookieOf(setCookie)))).toBeNull();
    const elsewhere = createPasswordAuth({ hash, sessionSecret: "t".repeat(40) }, { now: () => NOW });
    expect(await elsewhere.authenticate(requestWith(cookieOf(setCookie)))).toBeNull();
  });

  it("clears the cookie with Max-Age=0", () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET });
    expect(auth.clearCookie()).toBe(`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  });
});
