/**
 * Drives the land-document flow end to end against a running API.
 *
 *   pnpm dev:api          (in another shell, with the env from the README)
 *   pnpm walkthrough:land
 *
 * It exists because every time this flow was run rather than merely tested,
 * it turned up something the suite had missed — a missing RLS policy, an
 * infected file still sitting in storage, a marker combination the API would
 * not accept. The tests assert; this shows.
 *
 * Nothing here is a test. It makes no assertions and will happily print a
 * wrong answer, which is the point: it is for reading, and for showing
 * somebody what the system actually does.
 *
 * Development only. It uses the dev identity header and the fake vendor, both
 * of which the API refuses to run in production.
 */

import { createHash } from "node:crypto";
const API = "http://localhost:4000";
let seq = 0;

async function call(path, { method = "GET", body, userId, roles } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (userId) headers["x-dev-user-id"] = userId;
  if (roles) headers["x-dev-staff-roles"] = roles;
  // Every create needs one; the API refuses without it.
  if (method === "POST") headers["idempotency-key"] = `walk-${Date.now()}-${seq++}`;
  const res = await fetch(`${API}${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text.slice(0, 200); }
  return { status: res.status, body: parsed };
}

/** Reuse the dev identity if it is already there; the phone is unique. */
async function mkUser(phone, name) {
  const existing = (await call("/v1/dev/users")).body?.users ?? [];
  const found = existing.find((u) => u.phoneE164 === phone);
  if (found) return found.id;

  const r = await call("/v1/dev/users", { method: "POST", body: { phoneE164: phone, displayName: name } });
  if (r.status !== 201) throw new Error(`could not create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id ?? r.body.user?.id;
}

const ramesh = await mkUser("+919813000001", "Ramesh Kumar Sharma");
const mohan  = await mkUser("+919813000002", "Mohan Lal Yadav");
const priya  = await mkUser("+919813000090", "Priya Legal");

async function verify(who) {
  const consent = await call("/v1/kyc/consents", { method: "POST", userId: who,
    body: { purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" } });
  const session = await call("/v1/kyc/sessions", { method: "POST", userId: who,
    body: { level: "FULL", role: "LAND_OWNER", consentId: consent.body.id, locale: "en", testScenario: "pass" } });
  if (session.status !== 201) return `FAILED ${session.status} ${session.body?.code}`;
  const done = await call(`/v1/dev/kyc-sessions/${session.body.vendorSessionId}/complete`, { method: "POST" });
  return done.body?.status;
}
console.log(`KYC  ramesh=${await verify(ramesh)}  mohan=${await verify(mohan)}`);

async function lease(who) {
  const r = await call("/v1/kyc/can/ESIGN_LEASE", { userId: who });
  return r.body.allowed ? "ALLOWED" : `denied (${r.body.code})`;
}

async function uploadLand(who, opts = {}, docType = "JAMABANDI") {
  const t = await call("/v1/documents/upload-url", { method: "POST", userId: who,
    body: { docType, fileName: "jb.pdf", contentType: "application/pdf", sizeBytes: 2048,
            ...(opts.markers ? { testMarkers: opts.markers } : {}),
            ...(opts.khasra  ? { testKhasra:  opts.khasra  } : {}) } });
  if (t.status !== 201) { console.log("   upload-url", t.status, JSON.stringify(t.body)); return null; }
  const bytes = Buffer.from("%PDF-1.7\nland record\n");
  await fetch(t.body.url, { method: "PUT", headers: { "content-type": "application/pdf" }, body: bytes });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const c = await call("/v1/documents/confirm", { method: "POST", userId: who,
    body: { storageKey: t.body.key, sha256 } });
  return c.body;
}

const parcels = async (who) => (await call("/v1/land-parcels", { userId: who })).body.parcels ?? [];
const show = (p) => `${p.khasraNumber} ${p.village} · ${p.verificationStatus}` +
  (p.reasons.length ? ` [${p.reasons.map(r => r.code).join(", ")}]` : "");
const list = async (who) => (await parcels(who)).map(show).join("\n   ");
const approveDoc = (id) => call(`/v1/admin/documents/${id}/review`, { method: "POST",
  userId: priya, roles: "legal", body: { approved: true, note: "Khasra matches the village map." } });

console.log("\n1  verified, no land");
console.log("   lease:", await lease(ramesh));

console.log("\n2  uploads the Jamabandi");
const doc = await uploadLand(ramesh);
console.log(`   parcel created: ${Boolean(doc.landParcelId)} | scan: ${doc.scanStatus}`);
console.log("   " + await list(ramesh));
console.log("   lease:", await lease(ramesh));

console.log("\n3  Legal's queues");
const q  = await call("/v1/admin/land-parcels", { userId: priya, roles: "legal" });
const dq = await call("/v1/admin/documents",    { userId: priya, roles: "legal" });
console.log(`   ${q.body.parcels.length} parcel(s) waiting, ${dq.body.documents.length} document(s) (clean+legible => 0)`);

console.log("\n4  Legal approves the document");
console.log("   review:", (await approveDoc(doc.documentId)).status);
console.log("   " + await list(ramesh));
console.log("   lease:", await lease(ramesh));

console.log("\n5  he declares two siblings as co-owners");
const pid = (await parcels(ramesh))[0].id;
const co = await call(`/v1/land-parcels/${pid}/co-owners`, { method: "POST", userId: ramesh,
  body: { coOwnerNames: ["Sunita Sharma", "Mohan Lal Sharma"] } });
console.log(`   declared: ${co.status} | requiresAllCoOwners: ${co.body.requiresAllCoOwners}`);
console.log("   " + await list(ramesh));
console.log("   lease:", await lease(ramesh));

console.log("\n6  compliance tries to confirm the consent");
const bad = await call(`/v1/admin/land-parcels/${pid}/co-owner-consent`, { method: "POST",
  userId: priya, roles: "compliance", body: {} });
console.log(`   ${bad.status} ${bad.body.code}  (expect 403 NOT_YOUR_QUEUE)`);

console.log("\n7  Ramesh tries to confirm it himself");
const self = await call(`/v1/admin/land-parcels/${pid}/co-owner-consent`, { method: "POST",
  userId: ramesh, body: {} });
console.log(`   ${self.status} ${self.body.code}  (expect 404)`);

console.log("\n8  Legal confirms the co-owners agreed");
const ok = await call(`/v1/admin/land-parcels/${pid}/co-owner-consent`, { method: "POST",
  userId: priya, roles: "legal", body: { note: "Spoke to both siblings; they agree." } });
console.log(`   ${ok.status} -> ${ok.body.verificationStatus}`);
console.log("   lease:", await lease(ramesh));

console.log("\n9  the neighbour claims the same khasra");
const theirs = await uploadLand(mohan);
await approveDoc(theirs.documentId);
console.log("   mohan:  " + await list(mohan));
console.log("   mohan lease: ", await lease(mohan));
console.log("   ramesh lease:", await lease(ramesh), " <- must stay ALLOWED");

console.log("\n10 a second, different plot registered in somebody else's name");
const other = await uploadLand(ramesh, { khasra: "512/7", markers: ["owner-anita-desai"] }, "KHASRA_KHATAUNI");
await approveDoc(other.documentId);
console.log("   " + await list(ramesh));
console.log("   lease:", await lease(ramesh), " <- one good parcel is enough");
