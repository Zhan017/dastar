-- transaction: yes
-- impact: long-nonblocking
-- Marks the reference turns that exist already as due. A reference session's assistant turns are all judged, and before
-- 0028 nothing set the column, so those written earlier stand at false and the judge's scan would pass them over. External
-- turns need no backfill: before 0028 no post could ask for the judge, so none of them is due. This is its own file,
-- because 0028's alter table holds an exclusive lock on turn until its transaction ends, and an update of every reference
-- turn in that transaction would keep every reader and writer of turn waiting for as long as it runs; here the update
-- takes row locks only. The statement is repeatable: it touches only the turns not yet marked.

update dastar_agent.turn t
   set judge_due = true
  from dastar_agent.session s
 where s.id = t.session_id and s.venue_id = t.venue_id
   and s.kind = 'reference' and t.role = 'assistant' and not t.judge_due;
