-- transaction: yes
-- impact: instant-exclusive
-- No function in the schema is executable by PUBLIC. Postgres grants EXECUTE on a new function to PUBLIC by
-- default and checks it when a trigger is created, so the trigger functions are granted to no one; the helper
-- functions and the venue lookups keep the grants they have by name (0005, 0007).
revoke execute on all functions in schema dastar from public;
