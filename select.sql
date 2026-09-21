WITH distinct_hashes AS (
  SELECT DISTINCT w."id_hash"
  FROM public."wa" AS w
  WHERE w."id_hash" IS NOT NULL
    AND w."filetype" IN ('Image', 'image/jpeg')
    AND w."processed" IS TRUE
)
SELECT h."filename"
FROM distinct_hashes AS dh
JOIN public."hashes" AS h
  ON h."id" = dh."id_hash"
ORDER BY h."filename";