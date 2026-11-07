-- HDR and wide-gamut sources need an explicit color description so the pipeline
-- can tell an HDR file from an SDR one instead of guessing from bit depth alone.
ALTER TABLE media_metadata ADD COLUMN color_transfer TEXT;
ALTER TABLE media_metadata ADD COLUMN color_primaries TEXT;
