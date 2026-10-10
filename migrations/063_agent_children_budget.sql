-- What a background child may spend, held for it from its parent's spend limit while it runs (its share): a new child
-- gets an even share of what running children do not hold, so children started together cannot each spend it all.
alter table agent_children add column budget double precision;
