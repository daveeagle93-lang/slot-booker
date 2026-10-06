// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeH } from "./api.js";
import { shareControls } from "./share.js";

const h = makeH(document);
const tick = () => vi.advanceTimersByTimeAsync(0);
const SHARE_FAILED = "Sharing isn't available here. Use Copy message or Copy link.";

function mount(opts: { navigator?: unknown; clipboard?: unknown; message?: () => string; link?: () => string } = {}) {
  const node = shareControls({
    h, navigator: "navigator" in opts ? opts.navigator : {}, clipboard: "clipboard" in opts ? opts.clipboard : { writeText: vi.fn(async (_text: string) => {}) },
    getMessage: opts.message ?? (() => "Trial Day\nhttps://club.example/e/abc"), getLink: opts.link ?? (() => "https://club.example/e/abc"), label: "Trial Day",
  } as never);
  document.body.append(node);
  return node;
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const named = (text: string) => buttons().find((b) => b.textContent === text)!;
const status = () => document.querySelector(".share-status")!;
const field = () => document.querySelector("textarea, input") as HTMLTextAreaElement | HTMLInputElement | null;

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("where sharing is supported", () => {
  it("shows a Share button with the event name in its accessible name, and keeps Copy hidden", () => {
    mount({ navigator: { share: vi.fn(async (_data: { text: string }) => {}) } });
    expect(named("Share").getAttribute("aria-label")).toBe('Share "Trial Day"');
    expect(named("Share").hidden).toBe(false);
    expect(named("Copy message").hidden).toBe(true);
    expect(named("Copy link").hidden).toBe(true);
    expect(status().getAttribute("aria-live")).toBe("polite");
  });

  it("calls navigator.share exactly once, inside the click itself, with only the text, ending with the link", () => {
    const share = vi.fn(async (_data: { text: string }) => {});
    mount({ navigator: { share } });
    named("Share").click();
    expect(share).toHaveBeenCalledTimes(1); // no await, no microtask: it was called before click() returned
    expect(share.mock.calls[0]).toEqual([{ text: "Trial Day\nhttps://club.example/e/abc" }]);
    expect(Object.keys(share.mock.calls[0][0] as object)).toEqual(["text"]);
    expect((share.mock.calls[0][0] as { text: string }).text.endsWith("\nhttps://club.example/e/abc")).toBe(true);
  });

  it("says nothing when the share sheet is closed (AbortError)", async () => {
    mount({ navigator: { share: vi.fn(async () => { throw new DOMException("closed", "AbortError"); }) } });
    named("Share").click();
    await tick();
    expect(status().textContent).toBe("");
    expect(named("Copy message").hidden).toBe(true);
  });

  it("says nothing after a successful share", async () => {
    mount({ navigator: { share: vi.fn(async (_data: { text: string }) => {}) } });
    named("Share").click();
    await tick();
    expect(status().textContent).toBe("");
  });

  it("shows the Copy buttons and a message after any other failure, and they work", async () => {
    const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
    mount({ navigator: { share: vi.fn(async () => { throw new DOMException("no", "NotAllowedError"); }) }, clipboard });
    named("Share").click();
    await tick();
    expect(status().textContent).toBe(SHARE_FAILED);
    expect(named("Copy message").hidden).toBe(false);
    expect(named("Copy link").hidden).toBe(false);
    named("Copy link").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("https://club.example/e/abc");
    expect(status().textContent).toBe("Copied");
  });

  it("treats a rejection with no name, or a thrown value, as a failure", async () => {
    mount({ navigator: { share: vi.fn(() => Promise.reject(undefined)) } });
    named("Share").click();
    await tick();
    expect(status().textContent).toBe(SHARE_FAILED);
  });

  it("builds the message at each tap, from the event as it is then", async () => {
    const event = { name: "First" };
    const share = vi.fn(async (_data: { text: string }) => {});
    const getMessage = vi.fn(() => `Message for ${event.name}`);
    mount({ navigator: { share }, message: getMessage });
    expect(getMessage).not.toHaveBeenCalled();
    named("Share").click();
    event.name = "Renamed";
    named("Share").click();
    expect(share.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual(["Message for First", "Message for Renamed"]);
  });

  it("clears an earlier failure message when tapped again", async () => {
    const share = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    mount({ navigator: { share } });
    named("Share").click();
    await tick();
    expect(status().textContent).toBe(SHARE_FAILED);
    named("Share").click();
    expect(status().textContent).toBe("");
  });
});

describe("where sharing is not supported", () => {
  it.each([["an empty navigator", {}], ["no navigator", undefined], ["a share that isn't a function", { share: "yes" }]])("shows Copy message and Copy link, no Share (%s)", (_n, navigator) => {
    mount({ navigator });
    expect(buttons().map((b) => b.textContent)).toEqual(["Copy message", "Copy link"]);
    expect(buttons().every((b) => !b.hidden)).toBe(true);
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual(['Copy message for "Trial Day"', 'Copy link for "Trial Day"']);
  });

  it("copies the message, says Copied, and clears it after two seconds", async () => {
    const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
    mount({ clipboard });
    named("Copy message").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenCalledWith("Trial Day\nhttps://club.example/e/abc");
    expect(status().textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(2100);
    expect(status().textContent).toBe("");
  });

  it("copies the link", async () => {
    const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
    mount({ clipboard });
    named("Copy link").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenCalledWith("https://club.example/e/abc");
    expect(status().textContent).toBe("Copied");
  });

  it("builds the message at each click, from the event as it is then", async () => {
    const event = { name: "First" };
    const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
    mount({ clipboard, message: () => `Message for ${event.name}` });
    named("Copy message").click();
    await tick();
    event.name = "Renamed";
    named("Copy message").click();
    await tick();
    expect(clipboard.writeText.mock.calls.map((c) => c[0])).toEqual(["Message for First", "Message for Renamed"]);
  });

  it("on failure shows the message in a selected, read-only box and asks for a manual copy", async () => {
    mount({ clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    named("Copy message").click();
    await tick();
    const box = field() as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe("Trial Day\nhttps://club.example/e/abc");
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
    expect(status().textContent).toBe("Couldn't copy automatically. Copy the selected text manually.");
    expect(box.parentElement!.hidden).toBe(false);
  });

  it("on failure shows the link in a selected, read-only input", async () => {
    mount({ clipboard: null });
    named("Copy link").click();
    await tick();
    const box = field() as HTMLInputElement;
    expect(box.tagName).toBe("INPUT");
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe("https://club.example/e/abc");
    expect(document.activeElement).toBe(box);
    expect(status().textContent).toContain("manually");
  });

  it("hides the manual box again after a copy that works", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
    mount({ clipboard: { writeText } });
    named("Copy link").click();
    await tick();
    expect(field()).not.toBeNull();
    named("Copy link").click();
    await tick();
    expect(document.querySelector(".field")!.hasAttribute("hidden")).toBe(true);
    expect(status().textContent).toBe("Copied");
  });

  it("holds hostile text as text only", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    mount({ clipboard: null, message: () => hostile });
    named("Copy message").click();
    await tick();
    expect((field() as HTMLTextAreaElement).value).toBe(hostile);
    expect(document.querySelector("img, [onerror]")).toBeNull();
  });
});
