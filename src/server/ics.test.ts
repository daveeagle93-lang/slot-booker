import { describe, expect, it } from "vitest";
import { identityKeyOf } from "../core/identity";
import { bookingIcsUrl, bookingUid } from "./ics";

const uid = (slug: string, dog: string, handler: string, seq?: number) => bookingUid(slug, identityKeyOf([dog, handler]), seq);

describe("bookingUid", () => {
  it("is 32 hex characters of SHA-256 over slug|dogKey|handlerKey, then @slot-booker", async () => {
    const data = new TextEncoder().encode("slugslugslugslug1|rex|sam jones");
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await uid("slugslugslugslug1", "rex", "sam jones")).toBe(`${hex.slice(0, 32)}@slot-booker`);
    expect(await uid("slugslugslugslug1", "rex", "sam jones")).toMatch(/^[0-9a-f]{32}@slot-booker$/);
  });

  it("hashes the keys joined with a bar, as v1.0 did, so an existing booking keeps its UID", async () => {
    // The stored identity key joins the keys with U+001F; the UID's source does not.
    expect(await bookingUid("slugslugslugslug1", "rex\u001fsam jones")).toBe(await bookingUid("slugslugslugslug1", "rex\u001fsam jones", 1));
    const data = new TextEncoder().encode("slugslugslugslug1|rex|sam jones");
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await bookingUid("slugslugslugslug1", "rex\u001fsam jones")).toBe(`${hex.slice(0, 32)}@slot-booker`);
  });

  it("adds |#seq to the hashed text only from an identity's second booking, so each gets its own UID", async () => {
    const data = new TextEncoder().encode("slugslugslugslug1|rex|sam jones|#2");
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await uid("slugslugslugslug1", "Rex", "Sam Jones", 2)).toBe(`${hex.slice(0, 32)}@slot-booker`);
    expect(await uid("slugslugslugslug1", "Rex", "Sam Jones", 2)).not.toBe(await uid("slugslugslugslug1", "Rex", "Sam Jones", 3));
    expect(await uid("slugslugslugslug1", "Rex", "Sam Jones", 2)).not.toBe(await uid("slugslugslugslug1", "Rex", "Sam Jones", 1));
  });

  it("is the same for variants of one identity", async () => {
    expect(await uid("slugslugslugslug1", "Zoë", "Sam Jones")).toBe(await uid("slugslugslugslug1", "ZOË", " sam  jones "));
    expect(await uid("slugslugslugslug1", "Zoë", "Sam")).toBe(await uid("slugslugslugslug1", "Zoë", "Sam"));
  });

  it("differs across events, dogs and handlers, and does not let the parts slide", async () => {
    const base = await uid("slugslugslugslug1", "Rex", "Sam");
    expect(await uid("slugslugslugslug2", "Rex", "Sam")).not.toBe(base);
    expect(await uid("slugslugslugslug1", "Fido", "Sam")).not.toBe(base);
    expect(await uid("slugslugslugslug1", "Rex", "Ann")).not.toBe(base);
    expect(await uid("slugslugslugslug1", "ab", "c")).not.toBe(await uid("slugslugslugslug1", "a", "bc"));
  });
});

describe("bookingIcsUrl", () => {
  it("is a relative URL made of the slug and the token only", () => {
    expect(bookingIcsUrl("abc", "tok_en-1")).toBe("/api/events/abc/bookings/tok_en-1/ics");
  });
});
