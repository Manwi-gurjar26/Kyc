#!/usr/bin/env node
/**
 * Downloads the two face models the selfie check runs on.
 *
 *   node scripts/fetch-face-models.mjs
 *
 * Not committed: the recogniser is 38 MB, and a binary that size in git is
 * carried by every clone for ever. Fetched once per machine instead, into
 * packages/integrations/models/face, and pinned by SHA-256 — a model that
 * changes under us changes who is let through, so a mismatch is refused
 * rather than used.
 *
 * Both are from the OpenCV model zoo:
 *   YuNet  — face detector, MIT licence
 *   SFace  — face recogniser, Apache-2.0 licence
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "packages", "integrations", "models", "face");

const MODELS = [
  {
    file: "face_detection_yunet_2023mar.onnx",
    url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  },
  {
    file: "face_recognition_sface_2021dec.onnx",
    url: "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

await mkdir(target, { recursive: true });

for (const model of MODELS) {
  const path = join(target, model.file);

  if (existsSync(path) && sha256(await readFile(path)) === model.sha256) {
    console.log(`  ok        ${model.file}`);
    continue;
  }

  process.stdout.write(`  fetching  ${model.file} ... `);
  const response = await fetch(model.url);
  if (!response.ok) {
    console.error(`HTTP ${response.status}`);
    process.exit(1);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== model.sha256) {
    console.error(`checksum mismatch: got ${digest}, expected ${model.sha256}. Not installed.`);
    process.exit(1);
  }

  /** Written beside and renamed, so a half-downloaded file never sits at the real path. */
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
}

console.log(`Face models ready in ${target}`);
