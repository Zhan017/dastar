-- transaction: no
-- impact: long-nonblocking
-- the judge's scan for assistant turns that have no result yet, in order of turn id
create index concurrently if not exists turn_judge_due on dastar_agent.turn using btree (id) where ((role = 'assistant'::text) and (judge_result is null));
