-- Display rotation reported by the container's display matrix (0/90/180/270).
-- media_metadata.width/height store the displayed dimensions already swapped for
-- a quarter turn; this column preserves the evidence and lets the viewer say why.

ALTER TABLE media_metadata ADD COLUMN rotation_degrees INTEGER NOT NULL DEFAULT 0;
