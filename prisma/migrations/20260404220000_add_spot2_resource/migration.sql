-- Second venue per community: "Spot 2" where at least one resource exists and Spot 2 is not present yet.
INSERT INTO resources (id, name, community_id)
SELECT gen_random_uuid(), 'Spot 2', c.id
FROM communities c
WHERE EXISTS (SELECT 1 FROM resources r WHERE r.community_id = c.id)
  AND NOT EXISTS (
    SELECT 1 FROM resources r2
    WHERE r2.community_id = c.id AND r2.name = 'Spot 2'
  );
