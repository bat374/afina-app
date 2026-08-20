-- Additive only. Last 4 digits of the card, as printed on bank SMS/receipts (e.g. "3463"),
-- entered by the user against an account. Used to match an incoming SMS or receipt photo to the
-- right account without guessing (see BACKLOG.md R-01/R-02/R-03) — if 0 or 2+ accounts share the
-- same last 4 digits, the app asks the user to pick rather than picking for them. Never rewrites
-- existing data: accounts created before this column existed simply have it null until the user
-- fills it in from the account editor.
alter table public.accounts add column if not exists card_last4 text;
