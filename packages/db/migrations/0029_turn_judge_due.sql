-- transaction: no
-- impact: long-nonblocking
-- the judge's scan for the turns that are due and have no result yet, in order of turn id; a turn nobody asked to have judged is not in it
create index concurrently if not exists turn_judge_due on dastar_agent.turn using btree (id) where (judge_due and (judge_result is null));
