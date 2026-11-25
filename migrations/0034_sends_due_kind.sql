-- B141 (14-projects section 7, D155): the outbox claims transactional rows at once and marketing
-- rows only against the dispatcher's grant, so each claim names its kind. This index finds the
-- lowest due row of one kind without scanning a backlog of the other. Owned by src/messaging.
CREATE INDEX idx_sends_due_kind ON sends(status, kind, next_attempt_at, id);
