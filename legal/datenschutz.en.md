# Legal notice & privacy
<!--
  Prepared text for Ratespaß (English). {{NAME}} placeholders come from the operator's environment variables (see .env.example);
  lines starting with {{?NAME}} only appear if the variable is set, {{!NAME}} only if it is not.
  Any change to the text changes its checksum (version) – all players then consent once more.
  Own version: set LEGAL_DIR to a directory with datenschutz.de.md / datenschutz.en.md.
  Technical template, not legal advice – have it reviewed before public operation.
-->

## Summary
- You play with an anonymous profile: display name, progress and your answers are stored. No tracking, no ads, no cookies.
- Other players see your display name. Birth year and leaderboard are optional and only active if you choose them.
- You can withdraw your consent at any time: “Delete profile” removes your data.

## Controller and legal notice (§ 5 DDG)
{{CONTROLLER_NAME}}
{{CONTROLLER_ADDRESS}}
Email: {{CONTROLLER_EMAIL}}
{{?CONTROLLER_PHONE}}Phone: {{CONTROLLER_PHONE}}
{{?CONTROLLER_REPRESENTATIVE}}Represented by: {{CONTROLLER_REPRESENTATIVE}}
{{?CONTROLLER_REGISTER}}Register entry: {{CONTROLLER_REGISTER}}
{{?CONTROLLER_VAT_ID}}VAT ID: {{CONTROLLER_VAT_ID}}
{{?DPO_CONTACT}}Data protection officer: {{DPO_CONTACT}}

## What this app stores
- Anonymous profile: random friend code, display name of your choice, language, play level and category selection, a secret access key (in your browser, stored on the server only as a hash).
- Play history: games, rounds, answers (right/wrong, response time), results, million ladder progress, contacts (friend codes) you add.
- Wordle: your guesses and results per game (daily Wordle, bonus, groups), memberships in Wordle groups (group name, invitation code).
- Optional: username and password (hashed), birth year (year only), leaderboard name, your browser’s push subscription, your device’s time zone if you switch on the Wordle reminder (only for the “9 am” time), reviewer role.
- Technical: IP addresses only transiently in memory for abuse protection (rate limits); your browser stores the access key and settings locally (technically necessary, no tracking cookies).

## Purposes and legal bases
- Operating the game and matchmaking (Art. 6(1)(b) GDPR).
- Abuse protection, security and error analysis (Art. 6(1)(f) GDPR).
- Your consent (Art. 6(1)(a) GDPR) to use the app with an anonymous profile, for the optional birth year and for taking part in the leaderboard; you can withdraw it at any time with effect for the future.
- Anonymous statistics on how hard questions are for age groups (only with the optional birth year; groups under 5 answers are not evaluated).

## What others can see
- Opponents and fellow players in duels, rounds and live games see your display name and the result.
- Members of a Wordle group see your display name and whether you solved the group’s Wordle of the day and with how many guesses. The Wordle leaderboard shows only your leaderboard name, as with the quiz leaderboard, and only if you take part voluntarily.
- The leaderboard shows only your leaderboard name – or, if you explicitly choose so when joining, your display name (then visible to all visitors of the leaderboard) – and only if you actively take part. You can stop at any time; the name is removed immediately.
- Community questions you submit are published under CC BY-SA 4.0 with your consent; your name is not mentioned.

## Recipients and hosting
Hosting: {{HOSTING_PROVIDER}}. The host processes data on our behalf.
{{?ai}}AI features: questions are created and checked with an AI service. No player data is transmitted in the process.
{{!ai}}No data is transmitted to AI services.
Push messages go through your browser’s/operating system’s push service if you enable them.

## Retention
- Anonymous profiles without an account are deleted after {{PRIVACY_RETENTION_DAYS}} days without activity.
- Waiting games expire after 24 hours, multiplayer rounds are evaluated after 48 hours at the latest, inactive duels end after {{DUEL_FORFEIT_DAYS}} days. If your opponent does not respond for {{DUEL_TAKEOVER_HOURS}} hours, the duel can be continued with a bot; your previous play history in that duel then passes to the bot.
- With “Delete profile”, access, contacts, account, birth year, leaderboard name, Wordle games and memberships and your consent record are removed immediately; if you leave a Wordle group, your games in it are deleted; finished games remain anonymised for opponents (name “—”).

## Your rights
- Access and data portability: Profile → “Download profile & history”; additionally by email to the controller.
- Rectification (display name, birth year in your profile), erasure (“Delete profile”), restriction and objection to processing under Art. 6(1)(f).
- Withdrawal of consent at any time; the lawfulness of earlier processing remains unaffected.
- Complaint to a data protection supervisory authority.
{{?SUPERVISORY_AUTHORITY}}- Competent supervisory authority: {{SUPERVISORY_AUTHORITY}}

## Age and consent
Use requires that you are at least 16 years old or have your guardians’ consent (Art. 8 GDPR). Your consent is documented with time and version of this text. You are only asked again if this text changes.
