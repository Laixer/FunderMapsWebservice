// Source-document link for the research endpoints (issue
// Laixer/FunderMapsApi#140, ex-FunderMaps#1017).
//
// NWWI wants the PDF behind a facade scan / foundation research outcome, so
// the research responses carry a `resource` with a short-lived signed URL
// to the original document in the private bucket.
//
// Rule (Yorick, 2026-09-04, "option A"): the link is exactly as fresh as the
// data it rides on. facade_scan serves records < 3 years old, foundation
// research < 5 years — if the record is served, the link is included. There
// is deliberately NO separate document-age rule (the "max two years old"
// clause in the original issue text was overruled), so this module never
// looks at dates.
//
// Omit semantics: when the dossier has no document on file, the `resource`
// key is absent from the response — never `null`. The consumer's check is
// `"resource" in body`, and the field list in MIGRATION.md says so.
//
// Storage layout mirrors FunderMapsApi (src/lib/document-file.ts) and the
// retired C# stack: `report.inquiry.document_file` holds only the storage
// name, `<uuid>.<ext>`, and the object lives at `inquiry-report/<name>` in
// the bucket. Prod also carries the literal placeholder `file` on ~110
// legacy foundation-research rows whose document was never uploaded; the
// storage-name check treats anything that is not `<uuid>.<ext>` as "no
// document" so those never produce a link that 404s.
//
// Signing is done locally with Bun's built-in S3 client (SigV4 presign, no
// network round trip, no extra dependency) — the same presigned-GET pattern
// FunderMapsApi uses for its /download endpoints, at the same 1 h expiry.
// Existence in the bucket is NOT verified per request: that would put an
// object-storage round trip on a billable, mission-critical path.

import { S3Client } from "bun";
import { env } from "./config.ts";

/** How long a handed-out link stays valid. */
export const DOCUMENT_LINK_TTL_SECONDS = 3600;

export const INQUIRY_DOCUMENT_FOLDER = "inquiry-report";

export type SourceDocumentResource = {
  /** Presigned GET URL for the original document. */
  url: string;
  /** ISO-8601 instant after which `url` stops working. */
  expiresAt: string;
  /** Media type derived from the storage name's extension. */
  mediaType: string;
};

export type DocumentStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

// `<uuid>.<ext>` — the shape FileHelper.GetUniqueName / uniqueFileName()
// produce. Extension case varies in prod (`.pdf` and `.PDF` both occur).
const STORAGE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]+$/i;

/** True when `document_file` names a real stored object (not NULL, empty, or a placeholder). */
export function hasSourceDocument(
  documentFile: string | null | undefined,
): documentFile is string {
  return typeof documentFile === "string" && STORAGE_NAME.test(documentFile);
}

// Inverse of FunderMapsApi's EXT_BY_MIME (the upload whitelist).
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  txt: "text/plain",
};

export function mediaTypeOf(documentFile: string): string {
  const ext = documentFile.slice(documentFile.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export type DocumentLinker = (
  documentFile: string | null | undefined,
) => SourceDocumentResource | undefined;

/**
 * Builds the linker. `config === null` means storage is not configured: the
 * linker then always omits the resource and logs one structured line per
 * process so the gap is visible in the platform logs instead of silently
 * degrading the NWWI contract.
 */
export function createDocumentLinker(
  config: DocumentStorageConfig | null,
  options: { now?: () => number; ttlSeconds?: number; log?: (line: string) => void } = {},
): DocumentLinker {
  const now = options.now ?? Date.now;
  const ttlSeconds = options.ttlSeconds ?? DOCUMENT_LINK_TTL_SECONDS;
  const log = options.log ?? console.log;

  let client: S3Client | null = null;
  let warned = false;

  return (documentFile) => {
    if (!hasSourceDocument(documentFile)) return undefined;

    if (config === null) {
      if (!warned) {
        warned = true;
        log(
          JSON.stringify({
            event: "source_document_storage_not_configured",
            message:
              "S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY unset; research responses omit `resource`",
          }),
        );
      }
      return undefined;
    }

    client ??= new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      // DO Spaces: https://ams3.digitaloceanspaces.com/<bucket>/<key>
      virtualHostedStyle: false,
    });

    const issuedAt = now();
    const url = client.presign(`${INQUIRY_DOCUMENT_FOLDER}/${documentFile}`, {
      method: "GET",
      expiresIn: ttlSeconds,
    });

    return {
      url,
      expiresAt: new Date(issuedAt + ttlSeconds * 1000).toISOString(),
      mediaType: mediaTypeOf(documentFile),
    };
  };
}

export function documentStorageFromEnv(): DocumentStorageConfig | null {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    return null;
  }
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  };
}

/** The process-wide linker used by the product routes. */
export const sourceDocumentResource: DocumentLinker = createDocumentLinker(
  documentStorageFromEnv(),
);
