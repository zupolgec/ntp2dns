-- Device passwords are shown in the panel on request, so they are stored as is.
-- Only hashes existed before: existing devices get a new password, visible in
-- the panel, to be set again on devices that update through dyndns2.
alter table devices add column password text not null default '';
update devices set password = lower(hex(randomblob(16)));
alter table devices drop column password_hash;
