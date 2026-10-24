-- ===================================================================
-- Each selfie keeps its own face-match score.
-- ===================================================================
--
-- The selfie is now compared with the Aadhaar photograph on our own server.
-- A clear mismatch is refused and the person asked to take another, so one
-- verification can have several selfies — and each needs to remember how it
-- scored. That is how the attempts are counted (three refusals and the case
-- goes to a reviewer instead), and how the reviewer sees what was tried.
--
-- A refused selfie is marked `approved = false`, the column a reviewer's
-- rejection already uses; it is not deleted, because a run of different
-- faces against one Aadhaar is exactly what a fraud reviewer needs to see.
--
-- Nullable: nothing was compared for every selfie taken before today, for any
-- other document type, or whenever there was no Aadhaar photograph to
-- compare against.
-- -------------------------------------------------------------------

ALTER TABLE "documents" ADD COLUMN "face_match_score" numeric(4, 3);
