import { describe, expect, it } from "vitest";
import { identityKey } from "../core/identity";
import { bookingIcsUrl, bookingUid } from "./ics";

const uid = (slug: string, dog: string, handler: string) => bookingUid(slug, identityKey(dog), identityKey(handler));

describe("bookingUid", () => {
  it("is 32 hex characters of SHA-256 over slug|dogKey|handlerKey, then @slot-booker", async () => {
    const data = new TextEncoder().encode("slugslugslugslug1|rex|sam jones");
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await bookingUid("slugslugslugslug1", "rex", "sam jones")).toBe(`${hex.slice(0, 32)}@slot-booker`);
    expect(await bookingUid("slugslugslugslug1", "rex", "sam jones")).toMatch(/^[0-9a-f]{32}@slot-booker$/);
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
  it("is a relative URL with each value percent-encoded", () => {
    expect(bookingIcsUrl("abc", "2026-06-13T08:15:00Z", "Zoë & Co?", "Sam/Jones #1")).toBe(
      "/api/events/abc/ics?slot=2026-06-13T08%3A15%3A00Z&dog=Zo%C3%AB%20%26%20Co%3F&handler=Sam%2FJones%20%231",
    );
  });
});
