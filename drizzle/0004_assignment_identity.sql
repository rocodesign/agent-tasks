CREATE UNIQUE INDEX `events_assignment_idx` ON `events` (`account_email`,`launch`) WHERE `type` = 'delegation.assigned';
