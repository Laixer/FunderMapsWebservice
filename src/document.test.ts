import { describe, test, expect } from "bun:test";
import {
  createDocumentLinker,
  hasSourceDocument,
  mediaTypeOf,
  DOCUMENT_LINK_TTL_SECONDS,
  type DocumentStorageConfig,
} from "./document.ts";

// Presigning is a local SigV4 computation — no network — so dummy
// credentials exercise the real code path.
const STORAGE: DocumentStorageConfig = {
  endpoint: "https://ams3.digitaloceanspaces.com",
  region: "us-east-1",
  bucket: "fundermaps",
  accessKeyId: "AKIATEST",
  secretAccessKey: "secret",
};

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const PDF = "8286ef68-9217-4508-b9e2-6d3e9c5a18da.pdf";

describe("hasSourceDocument", () => {
  test("a <uuid>.<ext> storage name counts, in either extension case", () => {
    expect(hasSourceDocument(PDF)).toBe(true);
    expect(hasSourceDocument("39F5C748-D0B1-44C1-A9E0-DB25D2C66B6C.PDF")).toBe(true);
    expect(hasSourceDocument("8c0a2d17-9216-4826-bd27-89139f193f75.jpg")).toBe(true);
  });

  test("NULL, empty and the legacy `file` placeholder mean no document", () => {
    expect(hasSourceDocument(null)).toBe(false);
    expect(hasSourceDocument(undefined)).toBe(false);
    expect(hasSourceDocument("")).toBe(false);
    expect(hasSourceDocument("file")).toBe(false);
  });

  test("anything that is not a bare storage name is rejected (no path smuggling)", () => {
    expect(hasSourceDocument("../secrets.txt")).toBe(false);
    expect(hasSourceDocument(`sub/${PDF}`)).toBe(false);
    expect(hasSourceDocument(`${PDF}?x=1`)).toBe(false);
    expect(hasSourceDocument("report.pdf")).toBe(false);
  });
});

describe("mediaTypeOf", () => {
  test("maps the upload whitelist extensions, case-insensitively", () => {
    expect(mediaTypeOf(PDF)).toBe("application/pdf");
    expect(mediaTypeOf("x.PDF")).toBe("application/pdf");
    expect(mediaTypeOf("x.jpg")).toBe("image/jpeg");
    expect(mediaTypeOf("x.jpeg")).toBe("image/jpeg");
    expect(mediaTypeOf("x.png")).toBe("image/png");
  });

  test("unknown extension falls back to octet-stream", () => {
    expect(mediaTypeOf("x.bin")).toBe("application/octet-stream");
  });
});

describe("createDocumentLinker (storage configured)", () => {
  const link = createDocumentLinker(STORAGE, { now: () => NOW });

  test("a stored document yields a presigned GET on inquiry-report/<name> valid for 1 h", () => {
    const resource = link(PDF);
    expect(resource).toBeDefined();
    const url = new URL(resource!.url);
    expect(url.origin).toBe("https://ams3.digitaloceanspaces.com");
    expect(url.pathname).toBe(`/fundermaps/inquiry-report/${PDF}`);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toStartWith("AKIATEST/");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(DOCUMENT_LINK_TTL_SECONDS));
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(DOCUMENT_LINK_TTL_SECONDS).toBe(3600);
  });

  test("expiresAt = issue time + TTL, as an ISO instant", () => {
    const resource = link(PDF)!;
    expect(resource.expiresAt).toBe(
      new Date(NOW + DOCUMENT_LINK_TTL_SECONDS * 1000).toISOString(),
    );
    expect(resource.expiresAt).toBe("2026-09-04T13:00:00.000Z");
  });

  test("mediaType follows the storage name", () => {
    expect(link(PDF)!.mediaType).toBe("application/pdf");
    expect(link("8c0a2d17-9216-4826-bd27-89139f193f75.jpg")!.mediaType).toBe("image/jpeg");
  });

  test("no document on file → undefined (caller omits the key), never null", () => {
    expect(link(null)).toBeUndefined();
    expect(link("")).toBeUndefined();
    expect(link("file")).toBeUndefined();
  });

  test("a custom TTL is honoured in both the signature and expiresAt", () => {
    const short = createDocumentLinker(STORAGE, { now: () => NOW, ttlSeconds: 60 });
    const resource = short(PDF)!;
    expect(new URL(resource.url).searchParams.get("X-Amz-Expires")).toBe("60");
    expect(resource.expiresAt).toBe("2026-09-04T12:01:00.000Z");
  });
});

describe("createDocumentLinker (storage NOT configured)", () => {
  test("omits the resource and logs one structured line per process", () => {
    const lines: string[] = [];
    const link = createDocumentLinker(null, { log: (l) => lines.push(l) });

    expect(link(PDF)).toBeUndefined();
    expect(link(PDF)).toBeUndefined();
    expect(link(null)).toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "source_document_storage_not_configured",
    });
  });

  test("a dossier without a document does not trigger the warning at all", () => {
    const lines: string[] = [];
    const link = createDocumentLinker(null, { log: (l) => lines.push(l) });
    expect(link("file")).toBeUndefined();
    expect(lines).toHaveLength(0);
  });
});
