import { describe, expect, test } from "vitest";
import {
  DEV_DOCUMENT_EXAMPLES,
  FakeDocumentScanner,
  FakeDocumentExtractor,
  documentKeyMarkers,
} from "./fakeDocumentProvider.js";

/**
 * The fake virus scanner and the fake OCR extractor.
 *
 * Neither of these can do the real job: there is no virus scanner in a test,
 * and a fake cannot read a Jamabandi. What they can do is be *faithful* — give
 * the same shape of answer a real one gives, including the answers nobody
 * wants, so the code that consumes them is written against reality.
 *
 * The outcome is encoded in the object key, by convention, because a fake that
 * derives its answer from a hash is a fake nobody can steer. A developer who
 * needs to see what happens to an infected sale deed has to be able to produce
 * one on purpose.
 */

const SCANNER = new FakeDocumentScanner();
const EXTRACTOR = new FakeDocumentExtractor();

const CLEAN_DEED = "kyc-docs/usr_1/SALE_DEED/deed.pdf";

/* ------------------------------------------------------------------ */

describe("reading the markers out of a key", () => {
  test("a key with no markers has none", () => {
    expect(documentKeyMarkers(CLEAN_DEED)).toEqual({});
  });

  test("a marker is recognised anywhere in the final segment", () => {
    const markers = documentKeyMarkers(
      "kyc-docs/usr_1/SALE_DEED/deed--infected.pdf",
    );
    expect(markers.infected).toBe(true);
  });

  test("the khasra marker carries its number", () => {
    const markers = documentKeyMarkers(
      "kyc-docs/usr_1/JAMABANDI/jb--khasra-123-45.pdf",
    );
    expect(markers.khasraNumber).toBe("123/45");
  });

  test("the owner marker carries a name", () => {
    const markers = documentKeyMarkers(
      "kyc-docs/usr_1/JAMABANDI/jb--owner-anita-desai.pdf",
    );
    expect(markers.ownerName).toBe("ANITA DESAI");
  });

  /**
   * A marker in a directory segment is ignored. Otherwise a user who uploaded
   * under a path containing the word "infected" would steer the scanner, and
   * the convention would be an injection point rather than a dev tool.
   */
  test("a marker in a directory segment is not read", () => {
    expect(documentKeyMarkers("kyc-docs/usr--infected/x/deed.pdf")).toEqual({});
  });
});

/* ------------------------------------------------------------------ */

describe("scanning a document", () => {
  test("a document with no marker comes back clean", async () => {
    const result = await SCANNER.scan({ key: CLEAN_DEED });

    expect(result.status).toBe("CLEAN");
    expect(result.signature).toBeUndefined();
    expect(result.scannedAt).toBeInstanceOf(Date);
  });

  /**
   * The outcome that matters. An infected document must be reachable in
   * development, because the rule it proves — an INFECTED document can never
   * be used for anything — is the one rule here with a security consequence.
   */
  test("the infected marker reports a signature, not just a status", async () => {
    const result = await SCANNER.scan({
      key: "kyc-docs/usr_1/SALE_DEED/deed--infected.pdf",
    });

    expect(result.status).toBe("INFECTED");
    expect(result.signature).toBeTruthy();
  });

  /**
   * A scanner that is down is not a scanner that found nothing. ERRORED has to
   * be distinguishable from CLEAN, or an outage silently approves every upload
   * made during it.
   */
  test("the scanfail marker errors rather than passing", async () => {
    const result = await SCANNER.scan({
      key: "kyc-docs/usr_1/SALE_DEED/deed--scanfail.pdf",
    });

    expect(result.status).toBe("ERRORED");
    expect(result.error).toBeTruthy();
  });

  test("the same key always scans the same way", async () => {
    const a = await SCANNER.scan({ key: CLEAN_DEED });
    const b = await SCANNER.scan({ key: CLEAN_DEED });
    expect(a.status).toBe(b.status);
  });

  test("a key outside the kyc-docs prefix is refused", async () => {
    await expect(
      SCANNER.scan({ key: "agreements/signed/ppa.pdf" }),
    ).rejects.toThrow(/kyc-docs/);
  });
});

/* ------------------------------------------------------------------ */

describe("extracting fields from a land record", () => {
  test("a Jamabandi yields the fields a reviewer needs", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb.pdf",
      docType: "JAMABANDI",
    });

    expect(Object.keys(result.fields).sort()).toEqual([
      "areaAcres",
      "district",
      "khasraNumber",
      "ownerName",
      "village",
    ]);
  });

  test("every field carries a confidence", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb.pdf",
      docType: "JAMABANDI",
    });

    for (const [name, field] of Object.entries(result.fields)) {
      expect(field.confidence, name).toBeGreaterThan(0);
      expect(field.confidence, name).toBeLessThanOrEqual(1);
    }
  });

  test("the khasra marker is what the extractor reports", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb--khasra-512-7.pdf",
      docType: "JAMABANDI",
    });

    expect(result.fields.khasraNumber!.value).toBe("512/7");
  });

  test("the owner marker is what the extractor reports", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb--owner-anita-desai.pdf",
      docType: "JAMABANDI",
    });

    expect(result.fields.ownerName!.value).toBe("ANITA DESAI");
  });

  /**
   * A sale deed names two parties, and which of them is our customer is the
   * whole question. Returning only "ownerName" would let the pipeline skip
   * asking.
   */
  test("a sale deed names both parties", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/SALE_DEED/deed.pdf",
      docType: "SALE_DEED",
    });

    expect(result.fields).toHaveProperty("sellerName");
    expect(result.fields).toHaveProperty("buyerName");
    expect(result.fields).toHaveProperty("khasraNumber");
  });

  test("a GST certificate yields the GSTIN and the legal name", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/GST_CERTIFICATE/gst.pdf",
      docType: "GST_CERTIFICATE",
    });

    expect(result.fields).toHaveProperty("gstin");
    expect(result.fields).toHaveProperty("legalName");
  });

  /**
   * A selfie has no text. Returning an empty field set is the honest answer,
   * and the pipeline has to cope with it rather than assuming every document
   * produces data.
   */
  test("a document type with nothing to read yields no fields", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/SELFIE/selfie.jpg",
      docType: "SELFIE",
    });

    expect(result.fields).toEqual({});
  });
});

/* ------------------------------------------------------------------ */

describe("extraction quality markers", () => {
  /** A clean scan: everything above the floor, nothing for a human to do. */
  test("by default confidences are high", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb.pdf",
      docType: "JAMABANDI",
    });

    for (const field of Object.values(result.fields)) {
      expect(field.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  /**
   * A faded photocopy of a 1970s Jamabandi. This is the common case in
   * practice, not the exception, which is why it needs to be one marker away.
   */
  test("the lowconf marker drops every field below the floor", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb--lowconf.pdf",
      docType: "JAMABANDI",
    });

    for (const field of Object.values(result.fields)) {
      expect(field.confidence).toBeLessThan(0.85);
    }
  });

  /**
   * The interesting middle: enough is legible to pre-fill, but two fields are
   * not — which is exactly the threshold the guide puts a human behind.
   */
  test("the partial marker drops exactly two fields", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb--partial.pdf",
      docType: "JAMABANDI",
    });

    const low = Object.values(result.fields).filter((f) => f.confidence < 0.85);
    expect(low).toHaveLength(2);
  });

  test("the unreadable marker yields nothing at all", async () => {
    const result = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb--unreadable.pdf",
      docType: "JAMABANDI",
    });

    expect(result.fields).toEqual({});
  });

  test("extraction is deterministic for a key", async () => {
    const first = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb--partial.pdf",
      docType: "JAMABANDI",
    });
    const second = await EXTRACTOR.extract({
      key: "kyc-docs/usr_1/JAMABANDI/jb--partial.pdf",
      docType: "JAMABANDI",
    });

    expect(first.fields).toEqual(second.fields);
  });
});

/* ------------------------------------------------------------------ */

describe("the examples offered to a developer", () => {
  /**
   * The same reason the KYC scenario list is served to the UI: an outcome
   * nobody can reach is an outcome nobody tests.
   */
  test("every example covers a distinct outcome and is labelled", () => {
    expect(DEV_DOCUMENT_EXAMPLES.length).toBeGreaterThan(3);

    for (const example of DEV_DOCUMENT_EXAMPLES) {
      expect(example.label).toBeTruthy();
      expect(example.outcome).toBeTruthy();
      /**
       * A suffix, not a truthy suffix. The clean case is defined by needing no
       * marker at all, so its suffix is empty — requiring one would have meant
       * inventing a `--clean` marker to satisfy a test.
       */
      expect(typeof example.keySuffix).toBe("string");
    }
  });

  test("exactly one example needs no marker", () => {
    const unmarked = DEV_DOCUMENT_EXAMPLES.filter((e) => e.keySuffix === "");
    expect(unmarked).toHaveLength(1);
  });

  test("the infected and errored outcomes are both offered", () => {
    const outcomes = DEV_DOCUMENT_EXAMPLES.map((e) => e.keySuffix).join(" ");
    expect(outcomes).toContain("infected");
    expect(outcomes).toContain("scanfail");
  });
});
